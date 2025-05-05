/*
    Backend for transmission of data between the robot - dog and the client.
    Using Mediasoup to convert incoming RTP video source to a WebRTC web friendly source, consumable on the frontend.
*/

const os = require('os'); // For retrieving local network interfaces (IP addresses)
const readline = require('readline'); // For user interaction in console
const express = require('express'); // HTTP server framework
const http = require('http'); // Node.js HTTP server
const { Server } = require('socket.io'); // Real-time communication between server and frondend
const mediasoup = require('mediasoup'); // Core library for media handling

const app = express();
const server = http.createServer(app);

// Integrate socket.io with the HTTP server and enable connection recovery
const io = new Server(server, {
    connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes to reconnect
        skipMiddlewares: true,
    },
});

// Serve the static frontend files from the "client" directory
app.use(express.static(__dirname + '/../client'));

// Media pipeline objects
/** @type {mediasoup.types.Worker<mediasoup.types.AppData>} */
let worker;

/** @type {mediasoup.types.Router<mediasoup.types.AppData>} */
let router;

/** @type {mediasoup.types.PlainTransport<mediasoup.types.AppData>}*/
let plainTransport;

/** @type {mediasoup.types.Producer<mediasoup.types.AppData>}*/
let producer;

/** @type {Map<string, mediasoup.types.WebRtcTransport>} */
const transports = new Map(); // Stores WebRTC transports created for clients

/** @type {string} */
let selectedIp; // IP address chosen for binding incoming RTP

// New states for RTP auto-recovery
let isExpectingProducer = true; // Flag for determinating if we are wainting for a new RTP stream
let rtpTimeout; // Interval ID for the RTP monitoring loop

/**
 * Returns a list of non-internal IPv4 addresses on the system.
 * Shown to the user for them to select which one to bind the RTP socket to.
 * 
 * @returns {Array<{name: string, address: string}>} List of non-internal IP addresses, each with a name and address. 
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
 * Prompts user to select an IP address from the list.
 * RTP needs a concrete IP to listen on.
 *
 * @param {Array<{name: string, address: string}} ips - List of local IPs to select from.
 * @returns {Promise<string>} Resolves to the selected IP address.
 */
async function promptForIp(ips) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        console.log('[User Input] Select the IP address to use:');
        ips.forEach((ip, i) => {
            console.log(`[${i}] ${ip.name} - ${ip.address}`);
        });

        rl.question('Enter number: ', (answer) => {
            rl.close();
            const selected = ips[parseInt(answer)];
            if (!selected) {
                console.error('[Error] Invalid selection.');
                process.exit(1);
            }
            resolve(selected.address);
        });
    });
}

/**
 * Periodically monitors the producer RTP stream for activity - whether RTP packets are still arriving from the robot or not.
 * If packets stop flowing for too long, assumes the source has stopped and closes the producer, plus resets the state.
 * 
 * @returns {void} This function does not return any value.
 */
const monitorProducer = () => {
    const checkInterval = 5000; // Check every 5 sconds
    let lastPacketCount = 0;
    let stuckCount = 0;
    const maxStuckChecks = 3; // Allows 3 failed checks before givinf up

    clearInterval(rtpTimeout); // Clear previous interval if there is any
    rtpTimeout = setInterval(async () => {
        if (!producer || producer.closed) return;

        try {
            const statsArray = await producer.getStats();
            for (const stat of statsArray) {
                const currentCount = stat.packetCount || stat.packetsReceived || 0;

                if (currentCount > lastPacketCount) {
                     // RTP packets are still flowing
                    lastPacketCount = currentCount;
                    stuckCount = 0;
                    console.log(`[RTP] Packets flowing — total: ${currentCount}`);
                } else {
                    // No increase in packet count
                    stuckCount++;
                    console.log(`[RTP] No packet increase detected (${stuckCount}/${maxStuckChecks})`);
                }

                if (stuckCount >= maxStuckChecks) {
                    console.warn('[Warning] No RTP packets flowing — closing producer');
                    producer.close();
                    io.emit('mediaStopped');
                    isExpectingProducer = true;
                    clearInterval(rtpTimeout);
                    return;
                }
            }
        } catch (err) {
            console.error('[Error] Error getting producer stats:', err);
        }
    }, checkInterval);
};

/**
 * Main async block to initialize Mediasoup and set up RTP transport.
 */
(async () => {
    const ips = listLocalIps();
    if (ips.length === 0) {
        console.error('[Error] No non-internal IPv4 addresses found');
        process.exit(1);
    }

    selectedIp = await promptForIp(ips);
    console.log('[Info] Selected IP:', selectedIp);

    try {
        // Create a Mediasoup worker process
        worker = await mediasoup.createWorker();
        console.log('[Info] Mediasoup worker created');

        // Router defines supported media codecs and capabilities
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
        console.log('[Info] Router created');

        //Create a transport that listens for raw RTP - from the robot
        plainTransport = await router.createPlainTransport({
            listenIp: selectedIp,
            rtcpMux: false, // RTP and RTCP on separate ports
            comedia: true,  // Server will accept packets from any source - IP/port
        });

        console.log('[Info] Robot RTP transport listening:');
        console.log('[Info] IP address', selectedIp);
        console.log('[Info] RTP port:', plainTransport.tuple.localPort);
        console.log('[Info] RTCP port:', plainTransport.rtcpTuple.localPort);

        // When RTP packets arrive, attempt to create a producer if necessary
        plainTransport.on('tuple', async () => {
            console.log('[RTP] Incoming RTP detected at:', plainTransport.tuple.remoteIp, plainTransport.tuple.remotePort);

            // Reopen producer if needed
            if (!isExpectingProducer || (producer && !producer.closed)) return;

            try {
                console.log('[Producer] Creating new producer after incoming RTP...');

                // Define how incoming RTP should be interpreted
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
                        encodings: [{ ssrc: 22222222 }], // Hardcoded SSRC from the robot
                    },
                });

                console.log('[Producer] Producer created successfully');
                isExpectingProducer = false;

                monitorProducer(); // Start monitoring RTP flow from the robot

                // Clean up if the stream ends
                producer.on('trackended', () => {
                    console.log('[Producer] Track ended');
                    io.emit('mediaStopped');
                    isExpectingProducer = true;
                });
            } catch (err) {
                console.error('[Error] Failed to create producer:', err);
            }
        });
    } catch (err) {
        console.error('[Error] Error initializing Mediasoup:', err);
    }
})();

/**
 * Handles signaling for WebRTC using Socket.io.
 * Connects a producer (robot's video stream) with one or more clients.
 * Manages WebRTC transports, plus processes location updates.
 *
 * @param {Socket} socket - The Socket.io connection instance for a connected client.
 * @returns {void}
 */
io.on('connection', (socket) => {
    console.log(`[Socket.io] Client connected — sessionId: ${socket.id}`);

    // Send supported RTP capabilities to client
    socket.on('getRtpCapabilities', () => {
        if (!router) {
            console.error('[Error] Router not ready yet');
            return;
        }
        socket.emit('rtpCapabilities', router.rtpCapabilities);
    });

    // Create a WebRTC transport for the client
    socket.on('createTransport', async (callback) => {
        const transport = await router.createWebRtcTransport({
            listenIps: [{ ip: '0.0.0.0', announcedIp: selectedIp }],
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
        });

        transports.set(transport.id, transport);
        console.log('[Transport] Transport created with ID:', transport.id);

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
            console.log(`[Transport] Transport ${transportId} connected`);
            callback();
        } catch (err) {
            console.error('[Error] Error connecting transport with ID:',transportId, err);
            callback({ error: err.message });
        }
    });

    // Create a consumer to receive the video stream from the producer
    socket.on('consume', async ({ transportId, rtpCapabilities }, callback) => {
        if (!producer) {
            callback({ error: '[Error] No producer yet' });
            return;
        }

        const transport = transports.get(transportId);
        if (!transport) {
            callback({ error: '[Error] Invalid transport' });
            return;
        }

        console.log('[Transport] Transport found with ID:', transportId);

        try {
            const consumer = await transport.consume({
                producerId: producer.id,
                rtpCapabilities,
                paused: true, // Optimization: resume only when the client signals it is ready
            });

            console.log(`[Consumer] Created consumer for producer with ID: ${producer.id}`);

            callback({
                id: consumer.id,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
                type: consumer.type,
                producerId: producer.id,
            });

            // Resume the consumer once the client confirms it is ready
            socket.on('consumerCreated', async () => {
                consumer.resume();
            });
        } catch (error) {
            console.error('[Error] Error creating consumer:', error);
            callback({ error: '[Error] Failed to create consumer' });
        }
    });

    // Handle robot location data - for tracking
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

            console.log("[Info ]Starting location values validation")
            if (isFloat(locationArray[0]) && locationArray[1]) {
                //TODO: some more checks?
                socket.broadcast.emit("location", locationArray)
                callback({
                    locationArray: locationArray,
                })
                console.log("[Location] Location validation was successful")
                return;
            }
            throw new LocationValidationError("Location validation failed");
        }
        catch (error) {
            console.log("[Info] Location validation failed");
            callback({ locationArray: [0.0, 0.0] });
        }
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`[Server] Server running at http://localhost:${PORT}`);
});