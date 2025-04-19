import { Device } from 'mediasoup-client';

const socket = io();
const videoElement = document.getElementById('remoteVideo');
document.body.addEventListener('click',  () => {
    if (videoElement.srcObject) {
       videoElement.play().then(() => console.log('Playback started!'))
    }
});

let device;
let recvTransport;

socket.on('connect', async () => {
    console.log(`Connected with sessionId: ${socket.id}`);


    const rtpCapabilities = await new Promise((resolve) => {
        socket.emit('getRtpCapabilities', resolve);
        socket.on('rtpCapabilities', (capabilities) => {
            resolve(capabilities); 
        });
    });
    console.log('Received RTP Capabilities:', rtpCapabilities);

    device = new Device();
    await device.load({ routerRtpCapabilities: rtpCapabilities });
    console.log(device)

    const transportInfo = await new Promise((resolve) => {
        socket.emit('createTransport', resolve);
    });

    console.log('Transport created on client:', transportInfo.id);

    recvTransport = device.createRecvTransport(transportInfo);
    console.log('recvTransport created:', recvTransport.id);

    recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        console.log('recvTransport connect event');
        await socket.emit('connectTransport', { transportId: recvTransport.id, dtlsParameters: dtlsParameters }, () => {
                console.log('Transport connected to server');
                callback();
            }
        );
        console.log("connectTransport emitted")
    });

    recvTransport.on('connectionstatechange', (state) => {
        console.log('recvTransport connection state:', state);
    });
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
    
                const consumer = await recvTransport.consume(consumerParams);
                console.log('Consumer created:', consumer);
    
                const stream = new MediaStream();
                stream.addTrack(consumer.track);
                console.log('Track readyState:', consumer.track.readyState);
                console.log('Is track enabled?', consumer.track.enabled);

                videoElement.muted = true;
                videoElement.srcObject = stream;
                console.log(videoElement.srcObject)
                videoElement.play()
                
                videoElement.onwaiting = () => {
                    console.log("Video is buffering...");
                };
                
    
                videoElement.onerror = (e) => {
                    console.error('Video element error:', e);
                };
    
                console.log('Stream assigned to video', stream);
            } catch (err) {
                console.error('Error while consuming media:', err);
            }
        }
    );
    
    
});
