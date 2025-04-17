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

let worker, router, plainTransport, producer;
const transports = new Map()(async () => {
    worker = await mediasoup.createWorker();
    router = await worker.createRouter({
        mediaCodecs: [
            {
                kind: 'video',
                mimeType: 'video/H264',
                preferredPayloadType: 96,
                clockRate: 90000,
                parameters: {
                    'packetization-mode': 1,
                },
            },
        ],
    });

    console.log('Mediasoup router created');

    plainTransport = await router.createPlainTransport({
        listenIp: '0.0.0.0',
        rtcpMux: false,
        comedia: true,
    });
    console.log('Robot RTP transport listening:');
    console.log('RTP port:', plainTransport.tuple.localPort);
    console.log('RTCP port:', plainTransport.rtcpTuple.localPort);

    plainTransport.on('tuple', async () => {
        if (producer) return;

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
                            },
                        },
                    ],
                    encodings: [{ ssrc: 22222222 }],
                },
            });

            console.log('RTP producer from robot is active');
        } catch (err) {
            console.error('Failed to create producer:', err);
        }
    });
})();

//signaling server
io.on('connection', (socket) => {
    console.log(`Client connected — sessionId: ${socket.id}`);

    socket.on('message', (data) => {
        console.log('Received message:', data);
        socket.broadcast.emit('message', data);
    });

    //mediasoup signaling
    socket.on('getRtpCapabilities', () => {
        socket.emit('rtpCapabilities', router.rtpCapabilities);
    });

    socket.on('createTransport', async () => {
        const transport = await router.createWebRtcTransport({
            listenIps: [{ ip: '0.0.0.0', announcedIp: 'YOUR_PUBLIC_IP' }],
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
        });

        transports.set(transport.id, transport);

        socket.emit('transportCreated', {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
        });
    });

    socket.on('connectTransport', async ({ transportId, dtlsParameters }) => {
        const transport = transports.get(transportId);
        await transport.connect({ dtlsParameters });
        socket.emit('transportConnected');
    });

    socket.on('consume', async ({ transportId, rtpCapabilities }) => {
        if (!producer) {
            socket.emit('error', { message: 'No producer yet' });
            return;
        }

        const transport = transports.get(transportId);
        const consumer = await transport.consume({
            producerId: producer.id,
            rtpCapabilities,
            paused: false,
        });

        socket.emit('consumerCreated', {
            id: consumer.id,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
            type: consumer.type,
            producerId: producer.id,
        });
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
