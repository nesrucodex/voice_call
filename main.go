package main

import (
	"fmt"
	"log"
	"net/http"
	"webrtc/voice"
)

func main() {
	// Register WebSocket handlers
	fs := http.FileServer(http.Dir("./public"))
	http.Handle("/", fs)

	// Voice call handlers
	http.HandleFunc("/ws/caller", voice.HandleCallerWebSocket)
	http.HandleFunc("/ws/callee", voice.HandleCalleeWebSocket)

	// Start the server
	fmt.Println("Server started on :3000")
	if err := http.ListenAndServe(":3000", nil); err != nil {
		log.Fatal("Server error:", err)
	}
}
