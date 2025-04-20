/*
    Mockup testing client for video transmission
*/

import { Device } from 'mediasoup-client';

const socket = io();


let device;
let recvTransport;

socket.on('connect', async () => {
    console.log(`Connected with sessionId: ${socket.id}`);

    //Get what the server can do and send (codecs, headers...)
    const rtpCapabilities = await new Promise((resolve) => {
        socket.emit('getRtpCapabilities', resolve);
        socket.on('rtpCapabilities', (capabilities) => {
            resolve(capabilities);
        });
    });
    console.log('Received RTP Capabilities:', rtpCapabilities);

    //Configure the client to know what to expect from the server
    device = new Device();
    await device.load({ routerRtpCapabilities: rtpCapabilities });
    console.log(device);

    const transportInfo = await new Promise((resolve) => {
        socket.emit('createTransport', resolve);
    });

    console.log('Transport created on client:', transportInfo.id);

    recvTransport = device.createRecvTransport(transportInfo);
    console.log('recvTransport created:', recvTransport.id);

    //Handshake the connection
    recvTransport.on(
        'connect',
        async ({ dtlsParameters }, callback) => {
            console.log('recvTransport connect event');
            await socket.emit(
                'connectTransport',
                {
                    transportId: recvTransport.id,
                    dtlsParameters: dtlsParameters,
                },
                () => {
                    console.log('Transport connected to server');
                    callback();
                }
            );
            console.log('connectTransport emitted');
        }
    );

    //just debugging, if the state changes, be alerted
    recvTransport.on('connectionstatechange', (state) => {
        console.log('recvTransport connection state:', state);
    });

    //Consume the media from the producer established by the server
    socket.emit(
        'consume',
        {
            transportId: recvTransport.id,
            rtpCapabilities: device.rtpCapabilities,
        },
        async (consumerParams) => {
            try {
                console.log('Received consumer params:', consumerParams);

                if (!consumerParams.id) {
                    throw new Error('Consumer ID is missing!');
                }
                
                await recvTransport
                    .consume(consumerParams)
                    .then(async (consumer) => {
                        await socket.emit('consumerCreated');
                        console.log('Consumer created:', consumer);

                        const stream = new MediaStream();
                        stream.addTrack(consumer.track);
                        console.log(
                            'Track readyState:',
                            consumer.track.readyState
                        );
                        console.log(
                            'Is track enabled?',
                            consumer.track.enabled
                        );

                        videoElement.muted = true;
                        videoElement.srcObject = stream;
                        console.log(videoElement.srcObject);
                        console.log(stream.getVideoTracks());

                        videoElement.onerror = (e) => {
                            console.error('Video element error:', e);
                            console.log('Stream assigned to video', stream);
                        };
                        await videoElement.play();

                        videoElement.onwaiting = () => {
                            console.log('Video is buffering...');
                        };


                    });
            } catch (err) {
                console.error('Error while consuming media:', err);
            }
        }
    );
});
