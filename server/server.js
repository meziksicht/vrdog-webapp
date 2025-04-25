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
        maxDisconnectionDuration: 2 * 60 * 1000,
        skipMiddlewares: true,
    },
});

app.use(express.static(__dirname + '/../client'));

let worker;
let router;
let plainTransport;
let producer;
let isExpectingProducer = true;
const transports = new Map();
let selectedIp;
let rtpTimeout;

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

async function promptForIp(ips) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        console.log('Select the IP address to use:');
        ips.forEach((ip, i) => console.log(`[${i}] ${ip.name} - ${ip.address}`));
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
        });
        console.log('Mediasoup router created');

        plainTransport = await router.createPlainTransport({
            listenIp: selectedIp,
            rtcpMux: false,
            comedia: true,
        });

        console.log('Robot RTP transport listening:');
        console.log('RTP port:', plainTransport.tuple.localPort);
        console.log('RTCP port:', plainTransport.rtcpTuple.localPort);

        plainTransport.on('tuple', async () => {
            console.log('Received RTP on plainTransport');
            if (!isExpectingProducer || (producer && !producer.closed)) return;

            try {
                console.log('Reopening producer due to new RTP stream...');

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

                console.log('Producer reopened successfully.');
                isExpectingProducer = false;
                monitorProducer();

                producer.on('trackended', () => {
                    console.log('Producer track ended');
                    io.emit('mediaStopped');
                    isExpectingProducer = true;
                });
            } catch (err) {
                console.error('Error creating producer:', err);
            }
        });
    } catch (err) {
        console.error('Error initializing mediasoup:', err);
    }
})();

io.on('connection', (socket) => {
    console.log(`Client connected — sessionId: ${socket.id}`);

    socket.on('getRtpCapabilities', () => {
        if (!router) return;
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
            callback();
        } catch (err) {
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

        try {
            const consumer = await transport.consume({
                producerId: producer.id,
                rtpCapabilities,
                paused: true,
            });

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
            callback({ error: 'Failed to create consumer' });
        }
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
