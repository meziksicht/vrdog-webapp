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

let worker, router, plainTransport, producer;
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


//Signaling server connecting the producer (video stream from robot) to the consumer on the client
io.on('connection', (socket) => {
    console.log(`Client connected — sessionId: ${socket.id}`);

    //Negotiate codecs and video settings
    socket.on('getRtpCapabilities', () => {
        if (!router) {
            console.error('Router is not initialized yet');
            return;
        }
        socket.emit('rtpCapabilities', router.rtpCapabilities);
    });

    //Set up WebRTC transport
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
    //Client wants to connect
    socket.on(
        'connectTransport',
        async ({ transportId, dtlsParameters }, callback) => {
            try {
                const transport = transports.get(transportId);
                await transport.connect({ dtlsParameters });
                console.log(`Transport ${transportId} connected`);
                callback();
            } catch (err) {
                console.error('Error connecting transport:', err);
                callback({ error: err.message });
            }
        }
    );

    //Client emits consume to signal that it's ready to receive video from the producer
    socket.on('consume', async ({ transportId, rtpCapabilities }, callback) => {
        if (!producer) {
            callback({ error: 'No producer yet' });
            return;
        }

        const transport = await transports.get(transportId);

        if (!transport) {
            callback({ error: 'Invalid transport' });
            return;
        }
        console.log('Transport found', transportId);
        try {
            const consumer = await transport.consume({
                producerId: producer.id,
                rtpCapabilities,
                //paused: true as optimisation: https://mediasoup.discourse.group/t/why-do-we-need-to-consume-videos-as-paused/50
                paused: true,
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
            socket.on('consumerCreated', async () => {
                //Unpause transport after client creates consumer
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
