const VoiceCallVar = {
    iceCandidateQueue: []
};
let attempts = 0;

// WebRTC Configuration
const iceConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
    ],
    iceCandidatePoolSize: 10,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
};

// WebSocket URL
function getWebsocketUrl() {
    return window.location.protocol === "https:" 
        ? `wss://${window.location.host}` 
        : `ws://${window.location.host}`;
}

// Show toast notification
function showToast(message, duration = 3000) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    
    // Trigger reflow for animation
    toast.offsetHeight;
    toast.classList.add('show');

    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// Initialize WebSocket connection
function connectWebSocket(roomID, isCallee = false) {
    const endpoint = isCallee ? 'callee' : 'caller';
    VoiceCallVar.socket = new WebSocket(`${getWebsocketUrl()}/ws/${endpoint}?roomID=${roomID}`);

    VoiceCallVar.socket.onopen = () => {
        console.log('[+] WebSocket connected as ' + endpoint);
        updateStatus(`Connected as ${endpoint}`);
        document.querySelector('.avatar').classList.remove('disconnected');
        document.querySelector('.avatar').classList.add('connected');
        document.getElementById('reconnectBtn').style.display = 'none';
    };

    VoiceCallVar.socket.onerror = (error) => {
        console.error('[!] WebSocket error:', error);
        if (attempts < 15) {
            attempts++;
            setTimeout(() => connectWebSocket(roomID), 2000); // Retry connection
        } else {
            alert('WebSocket connection failed after multiple attempts');
            leaveRoom();
        }
    };

    VoiceCallVar.socket.onclose = () => {
        console.log('[!] WebSocket connection closed');
        updateStatus(`${endpoint} Disconnected.`);
        document.getElementById('reconnectBtn').style.display = 'flex';
        showToast(`${endpoint} connection lost.`);
    };

    VoiceCallVar.socket.onmessage = async (event) => {
        const message = JSON.parse(event.data);
        console.log('[+] WebSocket message:', message);

        if (message.type === 'roomCreated') {
            // Display the room ID when created
            displayRoomId(message.value);
            VoiceCallVar.roomID = message.value;
            showToast('Room created! Share the Room ID to start the call');
        } else if (message.type === 'userDisconnected') {
            showToast('Other user disconnected');
            document.querySelector('.avatar').classList.remove('connected');
            document.querySelector('.avatar').classList.add('disconnected');
            updateStatus('Other user disconnected');
        } else if (message.type === 'calleeJoined' || message.type === 'calleeReconnected') {
            console.log('[+] Callee joined/reconnected, creating offer...');
            document.querySelector('.avatar').classList.remove('disconnected');
            document.querySelector('.avatar').classList.add('connected');
            updateStatus('Connected');
            if (message.roomID) {
                displayRoomId(message.roomID);
                showToast('Callee reconnected to room: ' + message.roomID);
            }
            await createAndSendOffer();
        } else if (message.type === 'offer') {
            console.log('[+] Received offer, creating answer...');
            await handleOffer(JSON.parse(message.value));
        } else if (message.type === 'answer') {
            console.log('[+] Received answer');
            try {
                const answerDesc = new RTCSessionDescription(JSON.parse(message.value));
                if (VoiceCallVar.pc.signalingState === 'stable') {
                    console.log('Warning: Unexpected stable state when setting remote answer');
                    return;
                }
                await VoiceCallVar.pc.setRemoteDescription(answerDesc);
                // Process any queued ICE candidates
                while (VoiceCallVar.iceCandidateQueue.length > 0) {
                    const candidate = VoiceCallVar.iceCandidateQueue.shift();
                    await VoiceCallVar.pc.addIceCandidate(candidate);
                }
            } catch (err) {
                if (err.name === 'InvalidAccessError') {
                    console.log('Handling SDP order mismatch, resetting connection...');
                    await initializeWebRTC();
                    await createAndSendOffer();
                } else {
                    console.error('Error setting remote description:', err);
                    showToast('Connection error. Please try reconnecting.');
                }
            }
        } else if (message.type === 'iceCandidate') {
            console.log('[+] Received ICE candidate');
            const candidateInit = JSON.parse(message.value);
            if (!candidateInit.candidate) {
                console.log('Skipping empty ICE candidate');
                return;
            }
            const candidate = new RTCIceCandidate(candidateInit);
            try {
                if (VoiceCallVar.pc.remoteDescription && VoiceCallVar.pc.remoteDescription.type) {
                    await VoiceCallVar.pc.addIceCandidate(candidate);
                    console.log('Successfully added ICE candidate');
                } else {
                    console.log('Queuing ICE candidate');
                    VoiceCallVar.iceCandidateQueue.push(candidate);
                }
            } catch (err) {
                console.warn('Error adding ICE candidate:', err);
                // Don't throw - this is often recoverable
            }
        } else if (message.type === 'roomNotFound') {
            alert('Room not found');
            leaveRoom();
        } else if (message.type === 'roomClosed') {
            alert('Room closed');
            leaveRoom();
        }
    };
}

// Initialize WebRTC connection
async function initializeWebRTC() {
    console.log('[+] Initializing WebRTC...');
    if (VoiceCallVar.pc) {
        VoiceCallVar.pc.close();
        VoiceCallVar.iceCandidateQueue = [];
    }
    VoiceCallVar.pc = new RTCPeerConnection(iceConfig);

    // Handle ICE candidates
    VoiceCallVar.pc.onicecandidate = (event) => {
        if (event.candidate) {
            console.log('Generated ICE candidate for:', event.candidate.candidate);
            VoiceCallVar.socket.send(JSON.stringify({
                type: 'iceCandidate',
                value: JSON.stringify(event.candidate)
            }));
        }
    };

    // Handle ICE connection state
    VoiceCallVar.pc.oniceconnectionstatechange = () => {
        console.log('ICE connection state:', VoiceCallVar.pc.iceConnectionState);
        switch(VoiceCallVar.pc.iceConnectionState) {
            case 'failed':
                console.log('ICE connection failed, attempting recovery...');
                VoiceCallVar.pc.restartIce();
                break;
            case 'disconnected':
                console.log('ICE connection disconnected, waiting for recovery...');
                break;
            case 'connected':
                console.log('ICE connection established');
                break;
        }
    };

    // Handle ICE gathering state
    VoiceCallVar.pc.onicegatheringstatechange = () => {
        console.log('ICE gathering state:', VoiceCallVar.pc.iceGatheringState);
    };

    // Handle connection state changes
    VoiceCallVar.pc.onconnectionstatechange = () => {
        console.log('[+] Connection state:', VoiceCallVar.pc.connectionState);
        if (VoiceCallVar.pc.connectionState === 'connected') {
            showToast('WebRTC connection established');
        } else if (VoiceCallVar.pc.connectionState === 'failed') {
            showToast('WebRTC connection failed');
        }
    };

    // Handle remote audio stream
    VoiceCallVar.pc.ontrack = (event) => {
        console.log('[+] Received remote stream');
        const remoteAudio = new Audio();
        remoteAudio.srcObject = event.streams[0];
        remoteAudio.play().catch(err => {
            console.error('Error playing remote audio:', err);
        });
    };

    try {
        // Get local audio stream
        const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });
        VoiceCallVar.localStream = stream;
        stream.getTracks().forEach(track => {
            const sender = VoiceCallVar.pc.addTrack(track, stream);
            console.log('[+] Added local track:', track.kind);
        });

        // Setup mute button
        document.getElementById('muteAudio').onclick = () => {
            const muteBtn = document.getElementById('muteAudio');
            const tracks = stream.getAudioTracks();
            tracks.forEach(track => {
                track.enabled = !track.enabled;
                muteBtn.classList.toggle('muted');
                showToast(track.enabled ? 'Microphone unmuted' : 'Microphone muted');
            });
        };
    } catch (err) {
        console.error('Error accessing microphone:', err);
        showToast('Error accessing microphone. Please check permissions.');
    }
}

// Create and send offer (caller)
async function createAndSendOffer() {
    try {
        await initializeWebRTC();
        const transceivers = VoiceCallVar.pc.getTransceivers();
        transceivers.forEach(transceiver => {
            if (transceiver.sender.track && transceiver.sender.track.kind === 'audio') {
                transceiver.direction = 'sendrecv';
            }
        });
        
        const offer = await VoiceCallVar.pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: false,
            voiceActivityDetection: true
        });
        
        // Ensure the order of m-lines is consistent
        const sdp = offer.sdp.split('\nm=');
        const audioIndex = sdp.findIndex(section => section.startsWith('audio'));
        if (audioIndex > 0) {
            const audioSection = sdp[audioIndex];
            sdp.splice(audioIndex, 1);
            sdp.splice(1, 0, audioSection);
            offer.sdp = sdp.join('\nm=');
        }
        
        await VoiceCallVar.pc.setLocalDescription(offer);
        VoiceCallVar.socket.send(JSON.stringify({
            type: 'offer',
            value: JSON.stringify(offer)
        }));
    } catch (err) {
        console.error('Error creating offer:', err);
        showToast('Error creating connection offer');
    }
}

// Handle received offer (callee)
async function handleOffer(offer) {
    // Validate offer before processing
    if (!offer || !offer.sdp) {
        console.error('Invalid offer received');
        return;
    }
    try {
        await initializeWebRTC();
        const transceivers = VoiceCallVar.pc.getTransceivers();
        transceivers.forEach(transceiver => {
            if (transceiver.sender.track && transceiver.sender.track.kind === 'audio') {
                transceiver.direction = 'sendrecv';
            }
        });

        // Ensure we have a clean slate before setting remote description
        if (VoiceCallVar.pc.signalingState !== 'stable') {
            console.log('Signaling state not stable, rolling back');
            await Promise.all([
                VoiceCallVar.pc.setLocalDescription({type: 'rollback'}),
                VoiceCallVar.pc.setRemoteDescription(new RTCSessionDescription(offer))
            ]);
        } else {
            await VoiceCallVar.pc.setRemoteDescription(new RTCSessionDescription(offer));
        // Process any queued ICE candidates
        while (VoiceCallVar.iceCandidateQueue.length > 0) {
            const candidate = VoiceCallVar.iceCandidateQueue.shift();
            await VoiceCallVar.pc.addIceCandidate(candidate);
        }
        }
        
        const answer = await VoiceCallVar.pc.createAnswer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: false
        });
        
        await VoiceCallVar.pc.setLocalDescription(answer);
        VoiceCallVar.socket.send(JSON.stringify({
            type: 'answer',
            value: JSON.stringify(answer)
        }));
    } catch (err) {
        console.error('Error handling offer:', err);
        showToast('Error establishing connection. Please try again.');
    }
}

// Handle incoming offer
async function gotOffer(sessionID, offer) {
    if (VoiceCallVar.sessionID !== sessionID) return;

    await VoiceCallVar.pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await VoiceCallVar.pc.createAnswer();
    await VoiceCallVar.pc.setLocalDescription(answer);

    VoiceCallVar.socket.send(JSON.stringify({
        Type: 'gotAnswer',
        SessionID: VoiceCallVar.sessionID,
        Value: JSON.stringify(answer),
    }));
}

// Handle incoming ICE candidate
async function addCallerIceCandidate(sessionID, candidate) {
    if (VoiceCallVar.sessionID !== sessionID) return;
    await VoiceCallVar.pc.addIceCandidate(new RTCIceCandidate(candidate));
}

// Leave the room
function leaveRoom() {
    // Close WebRTC connection
    if (VoiceCallVar.pc) {
        VoiceCallVar.pc.close();
        VoiceCallVar.pc = null;
    }

    // Stop all audio tracks
    if (VoiceCallVar.localStream) {
        VoiceCallVar.localStream.getTracks().forEach(track => track.stop());
        VoiceCallVar.localStream = null;
    }

    // Close WebSocket connection
    if (VoiceCallVar.socket) {
        VoiceCallVar.socket.close();
        VoiceCallVar.socket = null;
    }

    // Reset UI
    updateStatus('Disconnected');
    document.getElementById('leaveRoom').disabled = true;
    document.getElementById('joinRoom').disabled = false;
    document.getElementById('muteAudio').classList.remove('muted');
    document.querySelector('.avatar').classList.remove('connected', 'disconnected');
    document.getElementById('reconnectBtn').style.display = 'none';
    
    // Show input field and hide room display
    document.getElementById('roomDisplay').style.display = 'none';
    document.getElementById('inputRoomID').style.display = 'block';
    document.getElementById('inputRoomID').value = '';
    
    // Reset connection attempts
    attempts = 0;
}

// Update UI status
function updateStatus(status) {
    const statusElement = document.getElementById('status');
    const statusText = statusElement.querySelector('.status-text');
    const avatar = document.querySelector('.avatar');
    const reconnectBtn = document.getElementById('reconnectBtn');
    
    statusText.textContent = status;
    
    if (status.includes('Disconnected')) {
        avatar.classList.remove('connected');
        avatar.classList.add('disconnected');
        statusElement.classList.add('disconnected');
        statusElement.classList.remove('connected');
        reconnectBtn.style.display = 'flex';
    } else if (status.includes('Connected')) {
        avatar.classList.remove('disconnected');
        avatar.classList.add('connected');
        statusElement.classList.add('connected');
        statusElement.classList.remove('disconnected');
        reconnectBtn.style.display = 'none';
    }
}

// Display room ID in the UI
function displayRoomId(roomId) {
    const roomDisplay = document.getElementById('roomDisplay');
    const roomIdElement = document.getElementById('roomID');
    roomIdElement.textContent = roomId;
    roomDisplay.style.display = 'block';

    // Setup copy button
    document.getElementById('copyRoom').onclick = async (ev) => {
        const button = ev.currentTarget;
        const span = button.querySelector('span');
        const originalText = span.innerText;

        try {
            if (navigator.clipboard) {
                await navigator.clipboard.writeText(roomId);
            } else {
                const textArea = document.createElement('textarea');
                textArea.value = roomId;
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand('copy');
                document.body.removeChild(textArea);
            }
            
            showToast('Room ID copied to clipboard');
            button.classList.add('copy-animation');
            span.textContent = 'Copied!';
            
            setTimeout(() => {
                span.textContent = originalText;
                button.classList.remove('copy-animation');
            }, 1000);
        } catch (err) {
            showToast('Failed to copy Room ID');
        }
    }
}

// Create or Join room
document.getElementById('joinRoom').onclick = () => {
    const roomID = document.getElementById('inputRoomID').value.trim();
    const isCallee = roomID.startsWith('room-');
    
    if (isCallee && !roomID) {
        showToast('Please enter a Room ID to join');
        return;
    }

    if (isCallee) {
        displayRoomId(roomID);
        showToast('Joining call...');
    } else {
        showToast('Creating new room...');
    }

    VoiceCallVar.roomID = roomID;
    connectWebSocket(roomID, isCallee);
    document.getElementById('joinRoom').disabled = true;
    document.getElementById('leaveRoom').disabled = false;
    document.getElementById('inputRoomID').style.display = 'none';
}

// Leave room
document.getElementById('leaveRoom').onclick = () => {
    if (VoiceCallVar.socket && VoiceCallVar.socket.readyState === WebSocket.OPEN) {
        VoiceCallVar.socket.send(JSON.stringify({
            type: 'userDisconnected',
            value: 'User left the call'
        }));
    }
    showToast('Leaving call...');
    leaveRoom();
};

// Handle reconnection
document.getElementById('reconnectBtn').onclick = () => {
    const btn = document.getElementById('reconnectBtn');
    btn.classList.add('spinning');
    showToast('Attempting to reconnect...');
    
    try {
        console.log({roomID: VoiceCallVar.roomID, isCallee: VoiceCallVar.roomID.startsWith('room-')})
        connectWebSocket(VoiceCallVar.roomID, VoiceCallVar.roomID.startsWith('room-'));
        showToast('Reconnected successfully');
    } catch (err) {
        showToast('Failed to reconnect');
        console.error('Reconnection failed:', err);
    } finally {
        btn.classList.remove('spinning');
    }
};