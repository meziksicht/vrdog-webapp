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

//RTP producer creation
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
            console.log("frames")
            console.log('Incoming RTP from FFmpeg at:', plainTransport.tuple.remoteIp, plainTransport.tuple.remotePort);

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


io.on('connection', (socket) => {
    console.log(`Client connected — sessionId: ${socket.id}`);

    socket.on('getRtpCapabilities', () => {
        
        if (!router) {
            console.error('Router is not initialized yet');
            return;
        }
        socket.emit('rtpCapabilities', router.rtpCapabilities);
    });
 

    socket.on('createTransport', async (callback) => {
        const transport = await router.createWebRtcTransport({
            listenIps: [{ ip: '0.0.0.0', announcedIp: 'YOUR_PUBLIC_IP' }],
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
        });
        
        transports.set(transport.id, transport);
        console.log("Transport created", transport.id)
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
            console.log(`✅ Transport ${transportId} connected`);
            callback(); // ✅ Acknowledge back to client
        } catch (err) {
            console.error('❌ Error connecting transport:', err);
            callback({ error: err.message }); // Optional: send back error info
        }
    });
    

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
        console.log("Transport found", transportId);
        try {
            const consumer = await transport.consume({
                producerId: producer.id,
                rtpCapabilities,
                paused: false,
            });
    
            console.log(`Created consumer for producer ${producer.id}`);
    
            callback({
                id: consumer.id, 
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
                type: consumer.type,
                producerId: producer.id,
            });
            console.log("Transport callback sent");
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
