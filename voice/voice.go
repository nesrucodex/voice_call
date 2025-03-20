package voice

import (
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// WebSocket upgrader
var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// VoiceRoom represents a voice call room
type VoiceRoom struct {
	ID         string
	CallerConn *websocket.Conn
	CalleeConn *websocket.Conn
}

// Message represents a WebSocket message
type Message struct {
	Type  string `json:"type"`  // e.g., "offer", "answer", "iceCandidate"
	Value string `json:"value"` // SDP or ICE candidate
}

var (
	voiceRooms   = make(map[string]*VoiceRoom) // Map to store active voice rooms
	voiceRoomsMu sync.Mutex                    // Mutex to protect the rooms map
)

// Generate a unique room ID
func generateRoomID() string {
	return fmt.Sprintf("room-%d", time.Now().UnixNano())
}

// Handle WebSocket connections for the caller
func HandleCallerWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("WebSocket upgrade error:", err)
		return
	}
	defer conn.Close()

	// Create a new room
	roomID := generateRoomID()
	room := &VoiceRoom{
		ID:         roomID,
		CallerConn: conn,
	}
	voiceRoomsMu.Lock()
	voiceRooms[roomID] = room
	voiceRoomsMu.Unlock()

	// Send the room ID to the caller
	conn.WriteJSON(Message{
		Type:  "roomCreated",
		Value: roomID,
	})

	// Handle incoming messages from the caller
	for {
		var msg Message
		if err := conn.ReadJSON(&msg); err != nil {
			log.Println("WebSocket read error:", err)
			break
		}

		// Forward the message to the callee
		if room.CalleeConn != nil {
			log.Printf("Forwarding message from caller to callee: %s", msg.Type)
			room.CalleeConn.WriteJSON(msg)
		}
	}

	// Handle caller disconnect
	voiceRoomsMu.Lock()
	if room := voiceRooms[roomID]; room != nil {
		room.CallerConn = nil
		// Only delete room if both participants are gone
		if room.CalleeConn == nil {
			delete(voiceRooms, roomID)
		}
	}
	voiceRoomsMu.Unlock()
}

// Handle WebSocket connections for the callee
func HandleCalleeWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("WebSocket upgrade error:", err)
		return
	}
	defer conn.Close()

	// Get the room ID from the query parameters
	roomID := r.URL.Query().Get("roomID")
	if roomID == "" {
		conn.WriteJSON(Message{
			Type:  "error",
			Value: "Room ID is required",
		})
		return
	}

	// Find the room
	voiceRoomsMu.Lock()
	room, exists := voiceRooms[roomID]
	voiceRoomsMu.Unlock()
	if !exists {
		conn.WriteJSON(Message{
			Type:  "error",
			Value: "Room not found",
		})
		return
	}

	// Update the callee connection
	room.CalleeConn = conn

	// If this is a reconnection and caller is still there, notify them
	if room.CallerConn != nil {
		room.CallerConn.WriteJSON(Message{
			Type:  "calleeReconnected",
			Value: roomID,
		})
	}

	// Notify the caller that the callee has joined
	if room.CallerConn != nil {
		room.CallerConn.WriteJSON(Message{
			Type:  "calleeJoined",
			Value: roomID,
		})
	}

	// Handle incoming messages from the callee
	for {
		var msg Message
		if err := conn.ReadJSON(&msg); err != nil {
			log.Println("WebSocket read error:", err)
			break
		}

		// Forward the message to the caller
		if room.CallerConn != nil {
			log.Printf("Forwarding message from callee to caller: %s", msg.Type)
			room.CallerConn.WriteJSON(msg)
		}
	}

	// Handle callee disconnect
	voiceRoomsMu.Lock()
	if room := voiceRooms[roomID]; room != nil {
		room.CalleeConn = nil
		// Only delete room if both participants are gone
		if room.CallerConn == nil {
			delete(voiceRooms, roomID)
		}
	}
	voiceRoomsMu.Unlock()
}
