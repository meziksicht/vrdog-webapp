/*
    Backend for transmission of data between the dog and client.
    Using mediasoup, converts RTP video source to a WebRTC web friendly source, consumable on the frontend.
*/

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000, //2 minutes
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

//RTP producer creation (source of media)
(async () => {
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
            listenIp: '127.0.0.1',
            rtcpMux: false,
            comedia: true,
        });

        console.log('Robot RTP transport listening:');
        console.log('RTP port:', plainTransport.tuple.localPort);
        console.log('RTCP port:', plainTransport.rtcpTuple.localPort);

        plainTransport.on('tuple', async () => {
            console.log(
                'Incoming RTP from FFmpeg at:',
                plainTransport.tuple.remoteIp,
                plainTransport.tuple.remotePort
            );

            try {
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
                        //IMPORTANT TO IDENTIFY THE RTP SOURCE
                        encodings: [{ ssrc: 22222222 }],
                    },
                });
                console.log('RTP producer from robot is active');
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

    /**
     * Sends router RTP capabilities to client for codec negotiation.
     * Client should call this immediately after connecting to be able to load the mediasoup Device.
     */
    socket.on('getRtpCapabilities', () => {
        if (!router) {
            console.error('Router is not initialized yet');
            return;
        }
        socket.emit('rtpCapabilities', router.rtpCapabilities);
    });

    /**
     * Creates a new WebRTC transport for the connected client.
     * Client will use this transport to consume the video stream.
     *
     * @param {Function} callback - Called with transport parameters:
     *   { id, iceParameters, iceCandidates, dtlsParameters }
     */
    socket.on('createTransport', async (callback) => {
        const transport = await router.createWebRtcTransport({
            listenIps: [{ ip: '0.0.0.0', announcedIp: '127.0.0.1' }],
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

    /**
     * Handles client request to connect its WebRTC transport.
     * Called once client transport emits its 'connect' event.
     *
     * @param {{ transportId: string, dtlsParameters: any }} params
     * @param {Function} callback - Signals transport connection success/failure.
     */
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

    /**
     * Handles consumer creation request from client.
     * Creates a consumer for the video producer and returns necessary parameters to client.
     * Client should call `consumer.resume()` only after it's ready to start receiving media.
     *
     * @param {{
     *   transportId: string,
     *   rtpCapabilities: mediasoup.types.RtpCapabilities
     * }} data - Request data with transport and capabilities.
     * @param {Function} callback - Sends consumer parameters to client:
     *   { id, kind, rtpParameters, type, producerId }
     */
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

            console.log('Transport callback sent');

            /**
             * Client should call this event once it's ready to consume the stream.
             * Resumes the paused consumer to start video delivery.
             */
            socket.on('consumerCreated', async () => {
                consumer.resume();
            });
        } catch (error) {
            console.error('Error creating consumer:', error);
            callback({ error: 'Failed to create consumer' });
        }
    });
});


const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
