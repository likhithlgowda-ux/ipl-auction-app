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

  // animation flags
  const [titleEntered, setTitleEntered] = useState(false);
  const [cardsEntered, setCardsEntered] = useState(false);
  const [showRules, setShowRules] = useState(false);

  const router = useRouter();

  // Anonymous auth so database rules with auth != null work
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

  // trigger entrance animations once on mount
  useEffect(() => {
    setTitleEntered(true);
    const id = setTimeout(() => setCardsEntered(true), 150);
    return () => clearTimeout(id);
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
        await navigator.clipboard.writeText(createdRoomId);
        alert("Room code copied to clipboard");
      } else {
        alert("Clipboard is not available in this browser.");
      }
    } catch (err) {
      console.error("Copy failed", err);
    }
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-black via-slate-950 to-slate-900 text-white flex items-center justify-center px-4">
      {/* subtle animated glow background */}
      <div className="pointer-events-none fixed inset-0 opacity-40 blur-3xl">
        <div className="absolute -top-32 -left-10 h-72 w-72 bg-emerald-500/40 rounded-full mix-blend-screen" />
        <div className="absolute bottom-0 right-0 h-80 w-80 bg-sky-500/40 rounded-full mix-blend-screen" />
      </div>

      <div className="relative w-full max-w-6xl space-y-10 z-10">
        {/* Title + subtitle with animate-in */}
        <header className="text-center space-y-3">
          <h1
            className={`text-4xl md:text-6xl font-extrabold tracking-tight transition-all duration-700 ease-out transform
              ${
                titleEntered
                  ? "opacity-100 translate-y-0 scale-100"
                  : "opacity-0 translate-y-6 scale-95"
              }`}
          >
            <span className="bg-gradient-to-r from-emerald-300 via-sky-300 to-purple-300 bg-clip-text text-transparent">
              Idiots Premier League Auction
            </span>
          </h1>
          <p
            className={`text-sm md:text-base text-gray-200 max-w-2xl mx-auto transition-opacity duration-700 delay-150 ${
              titleEntered ? "opacity-100" : "opacity-0"
            }`}
          >
            Spin up a fantasy auction room, invite your friends, and run a full
            IPL-style sale with real-time bidding, time banks, and automatic
            squad rules.
          </p>
        </header>

        {/* Create / Join cards */}
        <div
          className={`grid md:grid-cols-2 gap-8 items-stretch transition-all duration-700 ease-out transform ${
            cardsEntered
              ? "opacity-100 translate-y-0"
              : "opacity-0 translate-y-6"
          }`}
        >
          {/* Create Room */}
          <section className="h-full rounded-3xl p-7 md:p-9 bg-gradient-to-br from-emerald-600/40 via-emerald-500/15 to-slate-950 border border-emerald-300/60 shadow-[0_0_40px_rgba(16,185,129,0.3)] flex flex-col gap-5 hover:shadow-[0_0_55px_rgba(16,185,129,0.6)] hover:-translate-y-1 hover:scale-[1.02] transition-all duration-300">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-2xl md:text-3xl font-semibold mb-1">
                  Create a new room
                </h2>
                <p className="text-xs md:text-sm text-emerald-50/85">
                  Become the admin, configure scoring factors, and drive every
                  step of the auction.
                </p>
              </div>
              <span className="hidden md:inline-flex text-[11px] px-3 py-1 rounded-full bg-emerald-300 text-black font-semibold uppercase tracking-wide">
                Admin
              </span>
            </div>

            <div className="space-y-2 text-sm">
              <label className="block text-xs font-medium">Season</label>
              <input
                type="text"
                value={season}
                onChange={(e) => setSeason(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg bg-black/50 border border-emerald-200/70 outline-none focus:border-emerald-100 text-sm"
                placeholder="e.g. 2025"
              />
            </div>

            <button
              onClick={handleCreateRoom}
              disabled={creating || !authReady}
              className="mt-1 inline-flex items-center justify-center rounded-xl bg-emerald-300 hover:bg-emerald-200 text-black font-semibold px-5 py-3 text-sm md:text-base transition-all duration-200 disabled:bg-emerald-700 disabled:text-emerald-200 disabled:cursor-not-allowed hover:shadow-[0_15px_40px_rgba(16,185,129,0.4)]"
            >
              {!authReady
                ? "Connecting..."
                : creating
                ? "Creating room..."
                : "Create auction room"}
            </button>

            {createdRoomId && (
              <div className="mt-4 text-sm bg-black/40 border border-emerald-200/60 rounded-xl p-4 space-y-2 animate-[fadeIn_0.4s_ease-out]">
                <p className="font-medium">Room created!</p>
                <p className="flex flex-wrap items-center gap-3">
                  <span>Room code:</span>
                  <span className="font-mono text-xl tracking-[0.3em] bg-black/60 px-3 py-1 rounded-lg">
                    {createdRoomId}
                  </span>
                  <button
                    onClick={handleCopyCreatedCode}
                    className="px-3 py-1 text-[11px] rounded-lg bg-emerald-400 text-black font-semibold hover:bg-emerald-300 transition-colors"
                  >
                    Copy
                  </button>
                </p>
                <button
                  onClick={() => router.push(`/room/${createdRoomId}`)}
                  className="mt-2 px-4 py-2 rounded-lg bg-purple-500 hover:bg-purple-400 text-black text-xs font-semibold transition-colors"
                >
                  Go to room
                </button>
              </div>
            )}
          </section>

          {/* Join Room */}
          <section className="h-full rounded-3xl p-7 md:p-9 bg-gradient-to-bl from-sky-500/40 via-sky-500/15 to-slate-950 border border-sky-300/60 shadow-[0_0_40px_rgba(56,189,248,0.35)] flex flex-col gap-5 hover:shadow-[0_0_55px_rgba(56,189,248,0.7)] hover:-translate-y-1 hover:scale-[1.02] transition-all duration-300">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-2xl md:text-3xl font-semibold mb-1">
                  Join a room
                </h2>
                <p className="text-xs md:text-sm text-sky-50/85">
                  Enter the room code from your group and jump straight into the
                  live auction.
                </p>
              </div>
              <span className="hidden md:inline-flex text-[11px] px-3 py-1 rounded-full bg-sky-300 text-black font-semibold uppercase tracking-wide">
                Player
              </span>
            </div>

            <div className="space-y-2 text-sm">
              <label className="block text-xs font-medium">Room code</label>
              <input
                type="text"
                value={joinRoomId}
                onChange={(e) => setJoinRoomId(e.target.value)}
                placeholder="e.g. ABCDEF or legacy ID"
                className="w-full px-3 py-2.5 rounded-lg bg-black/50 border border-sky-200/70 outline-none focus:border-sky-100 text-sm"
              />
            </div>

            <button
              onClick={handleJoinRoomCheck}
              disabled={!authReady}
              className="inline-flex items-center justify-center rounded-xl bg-sky-300 hover:bg-sky-200 text-black font-semibold px-5 py-3 text-sm md:text-base transition-all duration-200 disabled:bg-sky-700 disabled:text-sky-200 disabled:cursor-not-allowed hover:shadow-[0_15px_40px_rgba(56,189,248,0.4)]"
            >
              {!authReady ? "Connecting..." : "Join auction room"}
            </button>

            {joinStatus && (
              <p className="mt-1 text-xs md:text-sm text-sky-50/90">
                {joinStatus}
              </p>
            )}
          </section>
        </div>

        {/* Rules section animated with cards */}
        <section
          className={`pt-2 flex justify-center transition-all duration-700 ease-out transform ${
            cardsEntered
              ? "opacity-100 translate-y-0"
              : "opacity-0 translate-y-6"
          }`}
        >
          <div
            onClick={() => setShowRules((v) => !v)}
            className="group max-w-3xl w-full cursor-pointer rounded-2xl border border-violet-300/70 bg-gradient-to-r from-violet-600/40 via-violet-500/15 to-slate-950 shadow-[0_0_35px_rgba(139,92,246,0.35)] px-5 py-4 md:px-6 md:py-5 transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_0_55px_rgba(139,92,246,0.7)]"
          >
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg md:text-xl font-semibold">
                Basic rules of the Idiots Premier League auction
              </h3>
              <span className="text-[11px] px-3 py-1 rounded-full bg-violet-200 text-violet-900 font-semibold uppercase tracking-wide group-hover:bg-violet-100 transition-colors">
                {showRules ? "Hide rules" : "Show rules"}
              </span>
            </div>
            <p className="mt-1 text-xs md:text-sm text-violet-50/90">
              Click to see how teams join, bid, and win players in this auction.
            </p>

            {showRules && (
              <div className="mt-3 text-xs md:text-sm text-violet-50/90 space-y-2 animate-[fadeIn_0.25s_ease-out]">
                <ul className="list-disc list-inside space-y-1">
                  <li>
                    The admin creates a room and shares the 6-letter room code
                    with everyone.
                  </li>
                  <li>
                    Each person joins the room, creates a team, and gets a fixed
                    purse in lakhs (shown in the auction screen).
                  </li>
                  <li>
                    Players come up for auction one-by-one in sets. Each player
                    starts from a base price and has a 30 second timer.
                  </li>
                  <li>
                    Any active team can bid as long as they have enough purse
                    left and haven&apos;t sat out on that player.
                  </li>
                  <li>
                    You can click <strong>Sit out</strong> on a player if you
                    don&apos;t want to bid; once you sit out you can&apos;t come
                    back in for that player.
                  </li>
                  <li>
                    When only one active team remains and it holds the highest
                    bid, that team automatically wins the player, even if time
                    is still left.
                  </li>
                  <li>
                    Teams that run out of purse or reach the squad limit are
                    automatically sat out for the rest of the auction.
                  </li>
                  <li>
                    When the auction finishes, everyone is taken to the team
                    setup / results view to see final squads and export CSVs.
                  </li>
                </ul>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
