# Vibe P2P Codebase Audit Findings

## Top 5 Priority Findings

**1. [P0 - Robustness] Media Transfer Promise Leak / Hang**
* **Location:** `vibedating/src/media.ts:71`
* **Failure Scenario:** `writeFrame` awaits `socket.once('drain', ...)` when a chunk writes false. If the socket closes or errors before `'drain'` fires, the Promise hangs forever. This leads to a severe memory and resource leak for any interrupted file transfer mid-stream.
* **Suggested Fix:** Add `'close'` and `'error'` listeners to the socket inside the Promise that explicitly `reject()` it, and clear them in `resolve()`.

**2. [P0 - Edge Case] No WebRTC Fallback for Symmetric NAT**
* **Location:** `vibedating/src/relay.ts:327` (and `link.ts`)
* **Failure Scenario:** Hyperswarm relies on DHT/UDP hole-punching. When both peers are behind symmetric NATs, hole-punching fails. The Nostr relay fallback explicitly ignores WebRTC signaling (`rtc-*` frames), rendering audio/video features unusable for these peers.
* **Suggested Fix:** Implement WebRTC `rtc-offer/answer/ice` signaling over the Nostr relay link (kind 4 payloads) and configure standard STUN/TURN servers in the browser `RTCPeerConnection` for when direct P2P fails.

**3. [P1 - Robustness] Silent Data Loss on Media Write**
* **Location:** `vibedating/src/media.ts:261`
* **Failure Scenario:** `writeFileSync(filePath, buf)` is wrapped in a `try...catch` that simply `return`s on failure. If the disk is full or the temp directory is unwritable, the media frame processing ends silently. The user is never notified that a received file failed to save.
* **Suggested Fix:** Alter `MediaReceiver`'s `onMedia` callback to accept an error state, or emit a synthetic error payload so the UI can alert the user.

**4. [P1 - Edge Case] Unbounded Buffer in Pairing Queue**
* **Location:** `vibedating/src/pairing.ts:45` (and `pairing.ts:89`)
* **Failure Scenario:** Unmatched links are pushed to a `queue: PeerLink[]`. There is no maximum length for this array. A malicious peer (or simple churn glitch) creating rapid connect/disconnect loops will indefinitely grow the queue, consuming process memory and ultimately causing an Out of Memory crash.
* **Suggested Fix:** Enforce a hard cap on `queue.length` (e.g., max 100). If exceeded, either drop new connections or eagerly `.close()` the oldest waiting links.

**5. [P1 - Robustness] Atomic Write Race Condition in State Persistence**
* **Location:** `vibedating/src/state.ts:99` (and lines 64, 218, 259)
* **Failure Scenario:** Profiles, blocklists, and consent ledgers are written directly to disk via `writeFileSync`. A concurrent read (such as from the stateless MCP server doing `loadProfile` at the exact same millisecond) will hit a partially-written or locked JSON file, causing `JSON.parse` to throw and corrupting the app's understanding of its own state.
* **Suggested Fix:** Write to a `.tmp` file first, then perform an atomic rename using `renameSync(tempPath, finalPath)`.

---

## Additional Findings (Categorized & Prioritized)

### Edge Cases

**6. [P1] Dead Link Selection During Peer Churn**
* **Location:** `vibedating/src/pairing.ts:97`
* **Failure Scenario:** When `next()` is called, it `shift()`s a link off the queue and makes it `current`. If that peer disconnected a millisecond prior, `current` is a dead link, and the local client is stuck "paired" with a ghost.
* **Suggested Fix:** In `next()`, use a `while` loop to repeatedly `shift()` until a link is found where `link.closed` is false, or the queue empties.

**7. [P1] Self-Connection Echo/Ghosting**
* **Location:** `vibedating/src/room.ts:164` (and `p2p.ts`)
* **Failure Scenario:** A client is permitted to connect to its own swarm node over the DHT. Since `entries.set` maps by handle, the client will "chat" with itself or attempt a WebRTC mesh with its own browser tab, resulting in echoing UI entries.
* **Suggested Fix:** During the `onLink` callback, check if `link.hello.handle === opts.hello.handle` (or check ed25519 pubkeys) and immediately close the link.

**8. [P1] Room Mesh Blowup (OOM / CPU Exhaustion)**
* **Location:** `vibedating/src/room.ts:200`
* **Failure Scenario:** `broadcast(text)` iterates across all members. A large room (e.g., 1000 members) on a public topic forces the local machine to manage 1000 hyperswarm links and perform 1000 synchronous `socket.write`s per chat message, stalling the Node.js event loop.
* **Suggested Fix:** Implement a hard limit on `entries.size` for rooms. Alternatively, switch from full mesh broadcast to a gossip-sub or delegated relay topology for rooms > 10 peers.

**9. [P2] WebRTC Glare / Negotiation Collision**
* **Location:** `vibedating/src/link.ts:184`
* **Failure Scenario:** Both peers click "Video Call" simultaneously. They both send an `rtc-offer` frame. Due to lack of a tie-breaker, the `RTCPeerConnection` on both sides may enter an invalid state and fail to negotiate.
* **Suggested Fix:** Apply the WebRTC "polite/impolite peer" pattern by lexicographically comparing handles or pubkeys to determine who rolls back their offer.

**10. [P2] Incomplete Relay Subscription Cleanups**
* **Location:** `vibedating/src/relay.ts:383`
* **Failure Scenario:** `pool.close(relays)` is called, but in many Node.js contexts, `nostr-tools` websockets do not immediately sever without a hard termination, leaving handles alive and preventing the process from exiting gracefully.
* **Suggested Fix:** Ensure all active subscriptions are explicitly closed, and enforce a hard teardown (`socket.terminate()`) on underlying pool connections if available.

### Speed

**11. [P1] O(N²) Array Splicing on Disconnect**
* **Location:** `vibedating/src/pairing.ts:71`
* **Failure Scenario:** The `watch()` cleanup function calls `queue.splice(idx, 1)`. In an environment with heavy peer churn (e.g., hundreds joining and dropping), constantly shifting the array elements causes O(N²) CPU slowdowns.
* **Suggested Fix:** Replace `PeerLink[]` queue with a `Set<PeerLink>` or a Doubly-Linked List to achieve O(1) removal.

**12. [P2] Blocking DHT Bootstrap**
* **Location:** `vibedating/src/p2p.ts:236` (and `vibenetwork/src/p2p.ts`)
* **Failure Scenario:** `await swarm.dht.fullyBootstrapped()` blocks until network consensus. If the user's connection is firewalled or offline, the app hangs indefinitely at startup.
* **Suggested Fix:** Wrap bootstrap in a `Promise.race` with a 3-5 second timeout. On timeout, gracefully degrade to the Nostr relay fallback immediately.

**13. [P2] Unbounded Synchronous Broadcast**
* **Location:** `vibedating/src/room.ts:200`
* **Failure Scenario:** In group rooms, `link.send(text)` is called sequentially. If a large text block is sent to many peers, memory buffers grow linearly because `broadcast` doesn't await `'drain'` backpressure on individual sockets.
* **Suggested Fix:** Chunk broadcasts using `setImmediate` or integrate a standard stream backpressure strategy across the member map.

**14. [P2] Overhead in Base64 Chunking**
* **Location:** `vibedating/src/media.ts:120`
* **Failure Scenario:** `data.subarray(off, off + chunkBytes).toString('base64')` allocates a new Buffer string synchronously on the main thread for every 12KB chunk, bottlenecking throughput on large file transfers.
* **Suggested Fix:** Use standard Node.js streaming (e.g., `pipeline` or `Transform` streams) combined with a base64 encoder stream to keep memory pressure minimal.

### Robustness

**15. [P1] Hostile Large File Loads in Memory**
* **Location:** `vibedating/src/media.ts:139` (`readFile(opts.path)`)
* **Failure Scenario:** `sendMediaFile` pulls the entire file into memory before initiating the transfer. If an attacker tricks the user into sending multiple 25MB files, the Node.js process experiences massive memory spikes.
* **Suggested Fix:** Read files via `fs.createReadStream` and pipe them through a chunking transformer, never holding the full file in memory.

**16. [P1] Duplicate Relay Event Processing**
* **Location:** `vibedating/src/room.ts:164`
* **Failure Scenario:** Re-handshakes over the same handle blindly overwrite `entries.set` but fail to unregister the old link's `onMessage` and `onSignal` callbacks. This leads to doubled/tripled incoming messages being pushed to the UI until the old sockets naturally close.
* **Suggested Fix:** Before `entries.set(handle, ...)` is called, check if an existing `entry` exists for that handle and call `cur.link.close()` explicitly.

**17. [P2] Nostr Ephemeral Presence Dropped**
* **Location:** `vibedating/src/relay.ts:108` (`VIBEDATE_PRESENCE_KIND = 30078`)
* **Failure Scenario:** Kind `30078` is a parameterized replaceable event. Some public Nostr relays aggressively garbage collect these. If the presence event drops before the peer subscribes, the NIP-04 key exchange fails, and the peer cannot decrypt messages.
* **Suggested Fix:** Use a more durable replaceable kind, or rebroadcast the presence event periodically while waiting for the first inbound message.

**18. [P2] Unsanitized Raw Peer Text in Terminal**
* **Location:** `vibenetwork/src/cli.ts` (implied untrusted boundaries)
* **Failure Scenario:** `text` is passed untreated. While the Web UI uses `.textContent` (preventing XSS), if the CLI prints raw peer messages using `console.log`, a malicious peer can inject ANSI escape codes to clear the screen, disguise text, or spoof system prompts.
* **Suggested Fix:** Run all `message.text` and `peer.handle` strings through an ANSI stripper regex before printing to standard out in the CLI module.

**19. [P2] Missing Max Length on Room Topics**
* **Location:** `vibedating/src/room.ts:40`
* **Failure Scenario:** The `name` parameter in `roomTopic(name)` is not length-capped. An attacker could pass a massive string payload, causing excessive string allocation and hashing overhead on the CPU.
* **Suggested Fix:** Assert that `name.length <= MAX_ROOM_NAME_LEN` (e.g., 64) before performing the SHA-256 derivation.

**20. [P2] Timestamp Spoofing on Wire Frames**
* **Location:** `vibedating/src/link.ts:101`
* **Failure Scenario:** `frame.at` is accepted from the peer verbatim. A malicious peer can spoof timestamps millions of years in the future or past, breaking UI message sorting and causing confusion.
* **Suggested Fix:** Enforce that `Math.abs(Date.now() - frame.at) < MAX_SKEW_MS` in the frame dispatcher, or simply override `m.at = Date.now()` locally upon receipt.