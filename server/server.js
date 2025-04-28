/*
    Backend for transmission of data between the dog and client.
    Using mediasoup, converts RTP video source to a WebRTC web friendly source, consumable on the frontend.
*/

const os = require('os');
const readline = require('readline');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
        skipMiddlewares: true,
    },
});

app.use(express.static(__dirname + '/../client'));

/** @type {mediasoup.types.Worker<mediasoup.types.AppData>} */
let worker;

/** @type {mediasoup.types.Router<mediasoup.types.AppData>} */
let router;

/** @type {mediasoup.types.PlainTransport<mediasoup.types.AppData>}*/
let plainTransport;

/** @type {mediasoup.types.Producer<mediasoup.types.AppData>}*/
let producer;

/** @type {Map<string, mediasoup.types.WebRtcTransport>} */
const transports = new Map();

/** @type {string} */
let selectedIp;

// New states for RTP auto-recovery
let isExpectingProducer = true;
let rtpTimeout;

/**
 * Lists all local IP addresses.
 */
function listLocalIps() {
    const interfaces = os.networkInterfaces();
    const ips = [];

    for (const [name, iface] of Object.entries(interfaces)) {
        for (const net of iface) {
            if (net.family === 'IPv4' && !net.internal) {
                ips.push({ name, address: net.address });
            }
        }
    }

    return ips;
}

/**
 * Prompts for an IP to listen on.
 *
 * @param {{name: string, address: string}[]} ips - List of local IPs to select from
 */
async function promptForIp(ips) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        console.log('Select the IP address to use:');
        ips.forEach((ip, i) => {
            console.log(`[${i}] ${ip.name} - ${ip.address}`);
        });

        rl.question('Enter number: ', (answer) => {
            rl.close();
            const selected = ips[parseInt(answer)];
            if (!selected) {
                console.error('Invalid selection.');
                process.exit(1);
            }
            resolve(selected.address);
        });
    });
}

/**
 * Monitors the producer RTP stream for activity.
 * If packets stop flowing for too long, closes the producer and resets state.
 */
const monitorProducer = () => {
    const checkInterval = 5000;
    let lastPacketCount = 0;
    let stuckCount = 0;
    const maxStuckChecks = 3;

    clearInterval(rtpTimeout);
    rtpTimeout = setInterval(async () => {
        if (!producer || producer.closed) return;

        try {
            const statsArray = await producer.getStats();
            for (const stat of statsArray) {
                const currentCount = stat.packetCount || stat.packetsReceived || 0;

                if (currentCount > lastPacketCount) {
                    lastPacketCount = currentCount;
                    stuckCount = 0;
                    console.log(`[DEBUG] Packets flowing — total: ${currentCount}`);
                } else {
                    stuckCount++;
                    console.log(`[DEBUG] No packet increase detected (${stuckCount}/${maxStuckChecks})`);
                }

                if (stuckCount >= maxStuckChecks) {
                    console.warn('No RTP packets flowing — closing producer');
                    producer.close();
                    io.emit('mediaStopped');
                    isExpectingProducer = true;
                    clearInterval(rtpTimeout);
                    return;
                }
            }
        } catch (err) {
            console.error('Error getting producer stats:', err);
        }
    }, checkInterval);
};

// RTP producer creation (source of media)
(async () => {
    const ips = listLocalIps();
    if (ips.length === 0) {
        console.error('No non-internal IPv4 addresses found');
        process.exit(1);
    }

    selectedIp = await promptForIp(ips);
    console.log('Selected IP:', selectedIp);

    try {
        worker = await mediasoup.createWorker();
        console.log('Mediasoup worker created');

        router = await worker.createRouter({
            mediaCodecs: [
                {
                    kind: 'video',
                    mimeType: 'video/H264',
                    preferredPayloadType: 96,
                    clockRate: 90000,
                    parameters: {
                        'packetization-mode': 1,
                        'profile-level-id': '42e01f',
                    },
                },
            ],
            logLevel: 'warn',
            logTags: [
                'info',
                'ice',
                'dtls',
                'rtp',
                'srtp',
                'rtcp',
                'rtx',
                'bwe',
                'score',
                'simulcast',
                'svc',
                'sctp',
            ],
        });
        console.log('Mediasoup router created');

        plainTransport = await router.createPlainTransport({
            listenIp: selectedIp,
            rtcpMux: false,
            comedia: true,
        });

        console.log('Robot RTP transport listening:');
        console.log('IP address', selectedIp);
        console.log('RTP port:', plainTransport.tuple.localPort);
        console.log('RTCP port:', plainTransport.rtcpTuple.localPort);

        plainTransport.on('tuple', async () => {
            console.log('Incoming RTP detected at:', plainTransport.tuple.remoteIp, plainTransport.tuple.remotePort);

            // Reopen producer if needed
            if (!isExpectingProducer || (producer && !producer.closed)) return;

            try {
                console.log('Creating new producer after incoming RTP...');

                producer = await plainTransport.produce({
                    kind: 'video',
                    rtpParameters: {
                        codecs: [
                            {
                                mimeType: 'video/H264',
                                payloadType: 96,
                                clockRate: 90000,
                                parameters: {
                                    'packetization-mode': 1,
                                    'profile-level-id': '42e01f',
                                },
                            },
                        ],
                        encodings: [{ ssrc: 22222222 }],
                    },
                });

                console.log('Producer created successfully');
                isExpectingProducer = false;

                monitorProducer(); // Start monitoring packet flow

                producer.on('trackended', () => {
                    console.log('Producer track ended');
                    io.emit('mediaStopped');
                    isExpectingProducer = true;
                });
            } catch (err) {
                console.error('Failed to create producer:', err);
            }
        });
    } catch (err) {
        console.error('Error initializing mediasoup:', err);
    }
})();

// Signaling server connecting the producer (video stream from robot) to the consumer on the client
io.on('connection', (socket) => {
    console.log(`Client connected — sessionId: ${socket.id}`);

    socket.on('getRtpCapabilities', () => {
        if (!router) {
            console.error('Router not ready yet');
            return;
        }
        socket.emit('rtpCapabilities', router.rtpCapabilities);
    });

    socket.on('createTransport', async (callback) => {
        const transport = await router.createWebRtcTransport({
            listenIps: [{ ip: '0.0.0.0', announcedIp: selectedIp }],
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
        });

        transports.set(transport.id, transport);
        console.log('Transport created', transport.id);

        callback({
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
        });
    });

    socket.on('connectTransport', async ({ transportId, dtlsParameters }, callback) => {
        try {
            const transport = transports.get(transportId);
            await transport.connect({ dtlsParameters });
            console.log(`Transport ${transportId} connected`);
            callback();
        } catch (err) {
            console.error('Error connecting transport:', err);
            callback({ error: err.message });
        }
    });

    socket.on('consume', async ({ transportId, rtpCapabilities }, callback) => {
        if (!producer) {
            callback({ error: 'No producer yet' });
            return;
        }

        const transport = transports.get(transportId);
        if (!transport) {
            callback({ error: 'Invalid transport' });
            return;
        }

        console.log('Transport found', transportId);

        try {
            const consumer = await transport.consume({
                producerId: producer.id,
                rtpCapabilities,
                paused: true, // optimization: resume only when client ready
            });

            console.log(`Created consumer for producer ${producer.id}`);

            callback({
                id: consumer.id,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
                type: consumer.type,
                producerId: producer.id,
            });

            socket.on('consumerCreated', async () => {
                consumer.resume();
            });
        } catch (error) {
            console.error('Error creating consumer:', error);
            callback({ error: 'Failed to create consumer' });
        }
    });

    //Location handling
    socket.on('locationHandling', async ({ locationArray }, callback) => {

        function LocationValidationError(message) {
            const error = new Error(message);
            error.name = 'LocationValidationError';
            return error;
        }

        try {
            // Checking if a value is a float
            function isFloat(value) {
                return typeof value === 'number' && !Number.isInteger(value);
            }

            console.log("Starting location values validation")
            if (isFloat(locationArray[0]) && locationArray[1]) {
                //TODO: some more checks?
                callback({
                    locationArray: locationArray,
                })
                console.log("Location validation was successful")
                return;
            }
            throw new LocationValidationError("Location validation failed");
        }
        catch (error) {
            console.log("Location validation failed");
            callback({ locationArray: [0.0, 0.0] });
        }
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
