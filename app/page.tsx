"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { db } from "../lib/firebase";
import { ref, set, get } from "firebase/database";
import { getAuth, onAuthStateChanged, signInAnonymously } from "firebase/auth";

// Generate a random 6-letter uppercase room code (A–Z only)
function generateRoomCode(length = 6): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

export default function Home() {
  const [creating, setCreating] = useState(false);
  const [createdRoomId, setCreatedRoomId] = useState<string | null>(null); // display code (6 letters)
  const [joinRoomId, setJoinRoomId] = useState("");
  const [joinStatus, setJoinStatus] = useState<string | null>(null);
  const [season, setSeason] = useState<string>("2025");

  const [authUid, setAuthUid] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);

  const router = useRouter();

  // Anonymous auth so database rules with auth != null work [web:38]
  useEffect(() => {
    const auth = getAuth();
    const unsub = onAuthStateChanged(auth, (user) => {
      if (user) {
        setAuthUid(user.uid);
        setAuthReady(true);
      } else {
        signInAnonymously(auth)
          .then((cred) => {
            setAuthUid(cred.user.uid);
            setAuthReady(true);
          })
          .catch((err) => {
            console.error("Anonymous sign-in failed", err);
            setAuthReady(true);
          });
      }
    });
    return () => unsub();
  }, []);

  // Create room with a unique 6-letter code (stored lowercase in DB, case-insensitive)
  const handleCreateRoom = async () => {
    if (!authUid) {
      alert("Authentication not ready yet, please wait a moment and try again.");
      return;
    }
    try {
      setCreating(true);
      setCreatedRoomId(null);

      // Try a few times to avoid collisions
      let displayCode: string | null = null;
      let dbKey: string | null = null;

      for (let attempt = 0; attempt < 5; attempt++) {
        const code = generateRoomCode(); // e.g. "ABXQTP"
        const key = code.toLowerCase();
        const roomRef = ref(db, `rooms/${key}`);
        const snap = await get(roomRef);
        if (!snap.exists()) {
          displayCode = code;
          dbKey = key;
          break;
        }
      }

      if (!displayCode || !dbKey) {
        alert("Failed to generate a unique room code. Please try again.");
        setCreating(false);
        return;
      }

      const now = Date.now();
      const roomRef = ref(db, `rooms/${dbKey}`);

      await set(roomRef, {
        status: "waiting",
        createdAt: now,
        config: {
          season,
          CF1: 30,
          CF2: 2000,
          CF3: 1.0
        }
      });

      setCreatedRoomId(displayCode);
    } catch (err) {
      console.error(err);
      alert("Failed to create room");
    } finally {
      setCreating(false);
    }
  };

  // Join room by ID:
  // - if 6-letter alphabetic -> normalize to lowercase DB key
  // - otherwise treat as legacy long Firebase key
  const handleJoinRoomCheck = async () => {
    if (!authUid) {
      setJoinStatus("Authentication not ready. Please wait a moment and try again.");
      return;
    }
    try {
      setJoinStatus("Checking room...");
      const trimmedId = joinRoomId.trim();
      if (!trimmedId) {
        setJoinStatus("Enter a room ID.");
        return;
      }

      const isShortCode =
        trimmedId.length === 6 && /^[A-Za-z]+$/.test(trimmedId);
      const dbKey = isShortCode ? trimmedId.toLowerCase() : trimmedId;

      const roomRef = ref(db, `rooms/${dbKey}`);
      const snap = await get(roomRef);
      if (snap.exists()) {
        setJoinStatus("Room found! Redirecting...");
        router.push(`/room/${trimmedId}`);
      } else {
        setJoinStatus("Room not found. Check the ID.");
      }
    } catch (err) {
      console.error(err);
      setJoinStatus("Error checking room.");
    }
  };

  const handleCopyCreatedCode = async () => {
    if (!createdRoomId) return;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(createdRoomId); // [web:514]
        alert("Room code copied to clipboard");
      } else {
        alert("Clipboard is not available in this browser.");
      }
    } catch (err) {
      console.error("Copy failed", err);
    }
  };

  return (
    <main className="min-h-screen bg-black text-white flex flex-col items-center justify-center p-4">
      <h1 className="text-3xl font-bold mb-6">
        Idiots Premier League Auction
      </h1>

      {/* Create Room */}
      <section className="border border-gray-700 rounded p-4 w-full max-w-md mb-8">
        <h2 className="text-xl font-semibold mb-2">
          Create a new auction room
        </h2>

        <div className="mb-3">
          <label className="block text-sm mb-1">Season</label>
          <input
            type="text"
            value={season}
            onChange={(e) => setSeason(e.target.value)}
            className="w-full px-2 py-1 rounded bg-gray-900 border border-gray-700 text-sm"
            placeholder="e.g. 2025"
          />
          <p className="text-xs text-gray-500 mt-1">
            Make sure you have imported stats for this season under
            seasons/{season}/players.
          </p>
        </div>

        <button
          onClick={handleCreateRoom}
          disabled={creating || !authReady}
          className="px-4 py-2 bg-green-600 rounded disabled:bg-gray-600"
        >
          {!authReady
            ? "Connecting..."
            : creating
            ? "Creating..."
            : "Create Room"}
        </button>

        {createdRoomId && (
          <div className="mt-4 text-sm">
            <p className="mb-1">Room created!</p>
            <p className="flex items-center gap-2">
              Room code:{" "}
              <span className="font-mono text-lg">
                {createdRoomId}
              </span>
              <button
                onClick={handleCopyCreatedCode}
                className="px-2 py-0.5 text-xs rounded bg-gray-800 border border-gray-600"
              >
                Copy
              </button>
            </p>
            <p className="text-xs text-gray-400 mt-1">
              Share this 6-letter code (case-insensitive) with others so they can join.
            </p>
            <button
              onClick={() => router.push(`/room/${createdRoomId}`)}
              className="mt-3 px-3 py-1 bg-purple-600 rounded"
            >
              Go to room
            </button>
          </div>
        )}
      </section>

      {/* Join Room */}
      <section className="border border-gray-700 rounded p-4 w-full max-w-md">
        <h2 className="text-xl font-semibold mb-2">
          Join an existing room
        </h2>
        <input
          type="text"
          value={joinRoomId}
          onChange={(e) => setJoinRoomId(e.target.value)}
          placeholder="Enter room code or legacy ID"
          className="w-full mb-2 px-2 py-1 rounded bg-gray-900 border border-gray-700"
        />
        <button
          onClick={handleJoinRoomCheck}
          disabled={!authReady}
          className="px-4 py-2 bg-blue-600 rounded disabled:bg-gray-600"
        >
          {!authReady ? "Connecting..." : "Join Room"}
        </button>

        {joinStatus && (
          <p className="mt-3 text-sm">
            {joinStatus}
          </p>
        )}
      </section>
    </main>
  );
}
