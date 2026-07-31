import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import DroneLink from "../lib/droneLink";
import { supabase, supabaseConfigured } from "../lib/supabase";
import { useAuth } from "./AuthContext";

const DroneContext = createContext(null);

// How long to wait before turning the camera off after the viewer goes away.
// Long enough to absorb React StrictMode's synchronous mount→cleanup→mount (and a
// quick navigation away-and-back), short enough that a genuine exit stops the Pi
// camera promptly. Only the OFF side is debounced; ON is always immediate.
const CAMERA_OFF_DEBOUNCE_MS = 400;

// How long to leave a camera_on unanswered before sending it again. Must clear
// start_camera()'s ~1s startup grace on the Pi plus the state round-trip, or a
// perfectly healthy start gets a second start piled on top of it while the first
// is still coming up. Slow on purpose: this is a self-heal, not a poll.
const CAMERA_RETRY_MS = 8000;

// Where the fleet actually serves video, so a drone saved without a URL still
// gets a working one. camera_stream.py pushes H.264 into MediaMTX over RTSP and
// browsers pull it back by WHEP; this is the public entry point to that, which
// beats a .local name for a default because it resolves off the LAN too. A blank
// camera_url is indistinguishable from a deliberate one — no feed renders, and
// `shouldCameraBeOn` stays false so the camera never even starts.
export const DEFAULT_CAMERA_URL = "https://cam.seagrassrobotics.com/cam/whep";

// Media (photos, recordings, TURN credentials) is a DIFFERENT host from the
// camera, so this cannot be left to the mediaBase fallback below: that keeps the
// camera's host and swaps in :8000, which for the public camera URL invents
// `https://cam.seagrassrobotics.com:8000` — nothing listens there, so the Media
// page 404s and WHEP silently drops to STUN-only. The two defaults are a pair;
// changing one without the other breaks the other half.
export const DEFAULT_MEDIA_URL = "https://media.seagrassrobotics.com";

// The previous default, from when camera_stream.py was a self-contained
// Picamera2 MJPEG server on :8000. That script is gone; :8000 is media_server.py
// now, which has no /stream.mjpg and answers 404 — and `streamType()` reads the
// .mjpg suffix as legacy MJPEG, so the app never even tries WHEP. Migrated below.
const LEGACY_CAMERA_URL = "http://seagrass.local:8000/stream.mjpg";

// Port media_server.py binds for /media, /photo, /record and /turn-credentials.
// Used to derive mediaBase from the camera URL's host, because the camera itself
// is on MediaMTX's :8889 and the two are separate servers.
const MEDIA_PORT = "8000";

const LOCAL_DRONE = {
  id: "local",
  name: "Seagrass One",
  host: "ws://seagrass.local:8765",
  camera_url: DEFAULT_CAMERA_URL,
  media_url: DEFAULT_MEDIA_URL,
  token: "",
};

// The Pi's hostname is `seagrass`, so `seagrass.local` resolves and
// `seagrass-pi.local` never has. It shipped as the default anyway, and a host
// saved in localStorage overrides the corrected default forever — the UI just
// sits on "Connecting…" while the server logs nothing at all, because the
// connection never leaves the laptop. Rewriting it is safe: that hostname
// resolves for nobody, so no working setup can depend on it.
const DEAD_HOST = "seagrass-pi.local";
const LIVE_HOST = "seagrass.local";

function migrateDeadHosts(fleet) {
  let changed = false;
  const migrated = fleet.map((d) => {
    let next = d;
    // BOTH address fields, not just `host`. The original repair only touched
    // `host`, which fixed the control link and left the camera pointed at the
    // same dead name — so the drone connected fine while the feed sat on
    // "Camera error — stream unreachable", which reads like a camera fault
    // rather than a hostname that resolves for nobody.
    for (const field of ["host", "camera_url"]) {
      const value = d?.[field];
      if (typeof value === "string" && value.includes(DEAD_HOST)) {
        changed = true;
        next = { ...next, [field]: value.replaceAll(DEAD_HOST, LIVE_HOST) };
      }
    }
    // Same class of problem, different shape: a wrong shipped default that
    // localStorage then pins forever. Filling a BLANK one in is safe because
    // blank has no behaviour to preserve — it renders no feed and blocks the
    // camera from starting. Anything the operator actually set, other than the
    // dead name handled above, is left strictly alone.
    if (!next.camera_url) {
      changed = true;
      next = { ...next, camera_url: DEFAULT_CAMERA_URL };
    }
    // Third instance of the same shape: the :8000 MJPEG default outlived the
    // server that answered it. Anyone whose blank was filled in while that was
    // the default is now pinned to a URL that 404s, which reads as a camera
    // fault rather than a stale address. Only the EXACT old default is rewritten
    // — a custom .mjpg elsewhere may well be a legacy rig that still works, and
    // that is the operator's call, not a default to be repaired.
    if (next.camera_url === LEGACY_CAMERA_URL) {
      changed = true;
      next = { ...next, camera_url: DEFAULT_CAMERA_URL };
    }
    // Keep the pair together. On the public camera host the mediaBase fallback
    // (camera host + :8000) points at nothing, so a blank media_url there is not
    // "derive it" — it's a broken Media page and STUN-only WHEP. Only ever
    // filled alongside the public camera URL; a LAN camera_url still derives its
    // media host correctly and is left to do so.
    if (next.camera_url === DEFAULT_CAMERA_URL && !next.media_url) {
      changed = true;
      next = { ...next, media_url: DEFAULT_MEDIA_URL };
    }
    return next;
  });
  return changed ? migrated : fleet;
}

function loadLocalFleet() {
  try {
    const raw = localStorage.getItem("seagrass-fleet");
    const fleet = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(fleet) || !fleet.length) return [LOCAL_DRONE];
    const migrated = migrateDeadHosts(fleet);
    if (migrated !== fleet) {
      // Persist so the repair survives a reload even if nothing else saves.
      try {
        localStorage.setItem("seagrass-fleet", JSON.stringify(migrated));
      } catch {
        /* storage full or blocked — the in-memory fix still applies this session */
      }
    }
    return migrated;
  } catch {
    return [LOCAL_DRONE];
  }
}

export function DroneProvider({ children }) {
  const { user, localMode } = useAuth();
  const linkRef = useRef(null);
  if (!linkRef.current) linkRef.current = new DroneLink();
  const link = linkRef.current;

  const [fleet, setFleet] = useState([]);
  const [fleetLoading, setFleetLoading] = useState(true);
  // Mirror of `fleet` for the local-storage path, which has to compute the next
  // list AND persist it in one go. Doing that inside a setFleet updater means
  // persisting from inside a render — and StrictMode runs updaters twice.
  const fleetRef = useRef(fleet);
  useEffect(() => {
    fleetRef.current = fleet;
  }, [fleet]);
  const [activeDroneId, setActiveDroneId] = useState(
    () => localStorage.getItem("seagrass-active-drone") || null,
  );

  const [linkStatus, setLinkStatus] = useState("disconnected");
  const [linkDetail, setLinkDetail] = useState("");
  const [armed, setArmed] = useState(false);
  const [flightMode, setFlightMode] = useState("MANUAL");
  const [pixhawkOk, setPixhawkOk] = useState(false);
  const [telemetry, setTelemetry] = useState({
    heading: null,
    groundspeed: null,
    battery: null,
    lat: null,
    lon: null,
    depth: null,
    altitude: null,
    climb: null,
    // EKF-fused attitude in degrees (roll/pitch signed, yaw 0–360).
    roll: null,
    pitch: null,
    yaw: null,
  });
  // Ping2 sonar. distance_m is the server-side FILTERED range (median of
  // confidence-gated samples — null when nothing real is in view); raw_m is the
  // latest unfiltered echo for debugging; quality is the lock state
  // ("good" | "weak" | "none"); ok tracks the serial link on the Pi.
  // `brake`/`braking` are the sonar brake's state, not the sensor's: the
  // fraction of forward thrust the server is withholding because something is
  // close ahead. They ride the sonar message because they are derived from it.
  const [sonar, setSonar] = useState({
    distance_m: null,
    raw_m: null,
    confidence: null,
    quality: "none",
    ok: false,
    brake: 0,
    braking: false,
  });
  // Altitude-hold PID demo state (server runs it on live baro altitude; output is
  // display-only). setpoint is the captured "hold" altitude; ok tracks whether the
  // server is currently feeding it altitude samples.
  const [pid, setPid] = useState({
    setpoint: null,
    measurement: null,
    error: null,
    integral: null,
    output: null,
    ok: false,
  });
  // Compass heading hold. Unlike `pid` above this one actually steers, so
  // `suspended` matters to the operator: engaged-but-yielding to their stick is
  // a different state from not engaged, and only `ok` means it is really driving.
  const [headingHold, setHeadingHold] = useState({
    engaged: false,
    suspended: false,
    setpoint: null,
    heading: null,
    error: null,
    output: 0,
    ok: false,
  });
  const [cameraActive, setCameraActive] = useState(false);
  // Why the Pi says the camera is down, when it knows. Server-supplied text;
  // null whenever the camera is running or the reason is simply "not started".
  const [cameraError, setCameraError] = useState(null);
  const [detectActive, setDetectActive] = useState(false);
  const [detections, setDetections] = useState([]); // latest bbox array
  // Recording lives on the Pi (see DroneLink protocol) — these mirror the Pi's
  // reported state so the UI's REC indicator/timer are the drone's truth, even
  // when recording was started server-side (auto-record on arm).
  const [recording, setRecording] = useState(false);
  const [recElapsed, setRecElapsed] = useState(0);
  const [autoRecord, setAutoRecordFlag] = useState(false);
  const [demoMode, setDemoMode] = useState(
    () => localStorage.getItem("seagrass-demo") === "1",
  );

  /* ---------- operator toasts (arm rejections, link errors, etc.) ---------- */
  const [toasts, setToasts] = useState([]); // [{ id, level, message }]
  const toastId = useRef(0);
  const pushToast = useCallback((level, message) => {
    if (!message) return;
    const id = ++toastId.current;
    setToasts((list) => [...list.slice(-4), { id, level, message }]);
    // auto-dismiss after a while; errors linger longer than warnings
    setTimeout(
      () => setToasts((list) => list.filter((t) => t.id !== id)),
      level === "error" ? 8000 : 5000,
    );
  }, []);
  const dismissToast = useCallback(
    (id) => setToasts((list) => list.filter((t) => t.id !== id)),
    [],
  );

  /* ---------- fleet loading ---------- */
  // Two stores, and which one is in play depends on how you got in:
  //   signed in            -> Supabase, scoped to you
  //   "Continue without
  //    account" (localMode) -> localStorage, this browser only
  //
  // The cloud branch is gated on `user` as well as `supabaseConfigured`. It used
  // not to be, because back then the drones table had no working per-user RLS —
  // auth.uid() was NULL under Firebase auth, so the policies were `using (true)`
  // and the fleet was simply shared by everyone. Now that auth is Supabase's,
  // auth.uid() is real and RLS returns only rows you own, so querying while
  // signed out is guaranteed to come back empty and there is no reason to ask.
  //
  // Note there is no .eq("owner", ...) below, deliberately. The filtering is the
  // database's job: a client-side filter would look identical in the UI while
  // leaving every row readable to anyone who bothered to call the REST endpoint
  // directly with the anon key, which ships in this bundle.
  const useCloudFleet = supabaseConfigured && !!user && !localMode;

  const refreshFleet = useCallback(async () => {
    setFleetLoading(true);
    let failure = null;
    if (useCloudFleet) {
      const { data, error } = await supabase
        .from("drones")
        .select("*")
        .order("created_at", { ascending: true });
      if (!error && data) setFleet(data);
      else {
        // A failed read used to be indistinguishable from an empty fleet: the
        // list was blanked and nothing was said. That is how a drone could be
        // registered successfully and still never appear — the insert worked,
        // the reload behind it did not, and the page looked exactly like a
        // fleet with nothing in it.
        setFleet([]);
        failure = error?.message || "Could not load your fleet.";
        pushToast("error", `Could not load fleet: ${failure}`);
      }
    } else if (localMode || !supabaseConfigured) {
      setFleet(loadLocalFleet());
    } else {
      setFleet([]);
    }
    setFleetLoading(false);
    return { ok: !failure, error: failure };
  }, [useCloudFleet, localMode, pushToast]);

  useEffect(() => {
    refreshFleet();
  }, [refreshFleet]);

  const saveDrone = useCallback(
    async (drone) => {
      if (useCloudFleet) {
        const row = {
          name: drone.name,
          host: drone.host,
          camera_url: drone.camera_url,
          media_url: drone.media_url ?? "",
          drone_id: drone.drone_id ?? "",
          token: drone.token ?? "",
          // Load-bearing now, not informational: the insert policy checks
          // `auth.uid() = owner`, so a row claiming anyone else is rejected by
          // Postgres rather than quietly written. `user.id` is the Supabase
          // user's uuid — under Firebase this read `user?.id` on an object whose
          // property is `uid`, so it silently wrote the string "local" for every
          // account, which is part of why nothing was ever attributable.
          owner: user.id,
        };
        // .select() so the write reports back what it actually stored. Without
        // it a policy that silently matches no rows — an update against a row
        // you don't own — returns no error and writes nothing, which is
        // "success" as far as the caller can tell.
        const { data, error } =
          drone.id && drone.id !== "new"
            ? await supabase.from("drones").update(row).eq("id", drone.id).select()
            : await supabase.from("drones").insert(row).select();
        // Previously unchecked, then toasted into a page that renders no
        // toasts: a rejected insert/update (RLS, an expired session, a missing
        // column) failed silently, with the modal closing and the fleet just
        // staying empty and no clue why. The error is now RETURNED as well, so
        // the caller can keep the form open and say what went wrong.
        if (error) {
          pushToast("error", `Could not save drone: ${error.message}`);
          return { ok: false, error: error.message };
        }
        if (!data?.length) {
          const detail =
            "the database accepted the request but stored no row (check that you are still signed in).";
          pushToast("error", `Could not save drone — ${detail}`);
          return { ok: false, error: detail };
        }
        const reloaded = await refreshFleet();
        return reloaded;
      } else {
        // The id is minted OUT here, not inside the updater: React invokes
        // state updaters twice under StrictMode, and Date.now() inside one can
        // hand the two passes different ids for the same drone.
        const id =
          drone.id && drone.id !== "new" ? drone.id : `local-${Date.now()}`;
        const prev = fleetRef.current;
        const next = prev.some((d) => d.id === id)
          ? prev.map((d) => (d.id === id ? { ...d, ...drone, id } : d))
          : [...prev, { ...drone, id }];
        setFleet(next);
        try {
          localStorage.setItem("seagrass-fleet", JSON.stringify(next));
        } catch {
          // The drone is in the list either way; what the operator needs to
          // know is that it won't survive a reload.
          pushToast(
            "warn",
            "Drone added, but this browser could not save it — it will be gone after a reload.",
          );
        }
        return { ok: true, error: null };
      }
    },
    [user, useCloudFleet, refreshFleet, pushToast],
  );

  const removeDrone = useCallback(
    async (id) => {
      if (useCloudFleet) {
        const { error } = await supabase.from("drones").delete().eq("id", id);
        if (error) {
          pushToast("error", `Could not remove drone: ${error.message}`);
          return { ok: false, error: error.message };
        }
        return await refreshFleet();
      } else {
        const next = fleetRef.current.filter((d) => d.id !== id);
        setFleet(next);
        try {
          localStorage.setItem("seagrass-fleet", JSON.stringify(next));
        } catch {
          pushToast("warn", "Removed, but this browser could not save the change.");
        }
        return { ok: true, error: null };
      }
    },
    [useCloudFleet, refreshFleet, pushToast],
  );

  const activeDrone = useMemo(
    () => fleet.find((d) => String(d.id) === String(activeDroneId)) || null,
    [fleet, activeDroneId],
  );

  const selectDrone = useCallback((id) => {
    setActiveDroneId(id);
    if (id) localStorage.setItem("seagrass-active-drone", String(id));
    else localStorage.removeItem("seagrass-active-drone");
  }, []);

  /* ---------- link events ---------- */
  useEffect(() => {
    return link.subscribe((event) => {
      if (event.type === "status") {
        setLinkStatus(event.status);
        setLinkDetail(event.detail || "");
        if (event.status !== "connected") {
          setArmed(false);
          setPixhawkOk(false);
          setCameraActive(false);
          setCameraError(null);
          setDetectActive(false);
          setDetections([]);
          // brake/braking clear with the rest: a "FWD STOP" warning left on
          // screen after the link dropped would be reporting a live restriction
          // that nothing is applying any more.
          setSonar({ distance_m: null, raw_m: null, confidence: null, quality: "none",
                     ok: false, brake: 0, braking: false });
          setPid({ setpoint: null, measurement: null, error: null, integral: null, output: null, ok: false });
          // The server releases the hold when the client drops, so the UI must
          // not keep showing "engaged" after a disconnect.
          setHeadingHold({ engaged: false, suspended: false, setpoint: null,
                           heading: null, error: null, output: 0, ok: false });
          setRecording(false);
          setRecElapsed(0);
        }
      } else if (event.type === "message") {
        const m = event.data;
        if (m.type === "state") {
          setArmed(Boolean(m.armed));
          if (m.mode) setFlightMode(m.mode);
          setPixhawkOk(Boolean(m.pixhawk));
          setCameraActive(Boolean(m.camera));
          setCameraError(m.camera ? null : m.camera_error || null);
          setDetectActive(Boolean(m.detect));
          setRecording(Boolean(m.recording));
          setRecElapsed(m.rec_elapsed_s || 0);
          setAutoRecordFlag(Boolean(m.autorecord));
        } else if (m.type === "telemetry") {
          setTelemetry((t) => ({ ...t, ...m }));
        } else if (m.type === "detections") {
          setDetections(m.boxes || []);
        } else if (m.type === "sonar") {
          setSonar({
            distance_m: m.distance_m ?? null,
            raw_m: m.raw_m ?? null,
            confidence: m.confidence ?? null,
            quality: m.quality ?? "none",
            ok: Boolean(m.ok),
            brake: m.brake ?? 0,
            braking: Boolean(m.braking),
          });
        } else if (m.type === "pid") {
          setPid({
            setpoint: m.setpoint ?? null,
            measurement: m.measurement ?? null,
            error: m.error ?? null,
            integral: m.integral ?? null,
            output: m.output ?? null,
            ok: Boolean(m.ok),
          });
        } else if (m.type === "heading_hold") {
          setHeadingHold({
            engaged: Boolean(m.engaged),
            suspended: Boolean(m.suspended),
            setpoint: m.setpoint ?? null,
            heading: m.heading ?? null,
            error: m.error ?? null,
            output: m.output ?? 0,
            ok: Boolean(m.ok),
          });
        } else if (m.type === "media_saved") {
          pushToast("warn", `📸 ${m.kind === "photo" ? "Photo" : "Clip"} saved · ${m.name}`);
        } else if (m.type === "notice") {
          // Server-side operator alert (arm rejection, PreArm reason, …).
          pushToast(m.level === "error" ? "error" : "warn", m.message);
        } else if (m.type === "error") {
          pushToast("error", m.message);
        }
      }
    });
  }, [link, pushToast]);

  /* ---------- demo mode simulation ---------- */
  useEffect(() => {
    localStorage.setItem("seagrass-demo", demoMode ? "1" : "0");
    if (!demoMode || linkStatus === "connected") return;
    let heading = 42;
    let altitude = 12.0; // wanders around the hold setpoint below
    const pidSetpoint = 12.0;
    let phase = 0; // drives a slow, believable attitude wobble
    const id = setInterval(() => {
      // A steady yaw with wobble on top, rather than a random walk. The walk
      // averaged out to no net rotation, which left the sonar accumulation map
      // — whose whole premise is that turning sweeps the beam — with nothing to
      // preview. ~7.8 deg/s puts a full circle just under a minute.
      heading = (heading + 7 + (Math.random() * 2 - 1) + 360) % 360;
      altitude = altitude + (Math.random() * 0.6 - 0.3); // drift ±0.3 m
      const climb = Number((Math.random() * 0.8 - 0.4).toFixed(2));
      // Gentle rolling/pitching swell rather than random jitter, so the
      // artificial horizon visibly moves instead of twitching.
      phase += 0.35;
      setTelemetry((t) => ({
        ...t,
        heading,
        groundspeed: 1.6 + Math.random() * 0.8,
        battery: 82,
        depth: 0.4 + Math.random() * 0.2,
        altitude: Number(altitude.toFixed(2)),
        climb,
        roll: Number((Math.sin(phase) * 14).toFixed(1)),
        pitch: Number((Math.sin(phase * 0.6) * 8).toFixed(1)),
        yaw: Number(heading.toFixed(1)),
      }));
      // Simulated submerged sonar: a wandering forward distance with a healthy
      // confidence, so the gauge previews live-looking data with no hardware.
      // The range spans the braking band deliberately — otherwise demo mode
      // could never show the brake indicator, which is the one part of this
      // feature that has no other way to be seen without water.
      const simDist = Number((0.4 + Math.random() * 3.2).toFixed(2));
      // Mirrors the server's SONAR_BRAKE_STOP_M / SONAR_BRAKE_SLOW_M defaults.
      // Preview only — the real value always comes from the server, which is
      // the only thing that actually withholds thrust.
      const simBrake = Math.max(0, Math.min(1, (2.0 - simDist) / (2.0 - 0.6)));
      setSonar({
        distance_m: simDist,
        raw_m: Number((simDist + (Math.random() * 0.2 - 0.1)).toFixed(2)),
        confidence: Math.round(55 + Math.random() * 35),
        quality: "good",
        ok: true,
        brake: Number(simBrake.toFixed(3)),
        braking: simBrake > 0,
      });
      // Simulated altitude-hold PID: error drives the (display-only) output.
      const error = pidSetpoint - altitude;
      setPid({
        setpoint: pidSetpoint,
        measurement: Number(altitude.toFixed(2)),
        error: Number(error.toFixed(3)),
        integral: Number((error * 0.5).toFixed(3)),
        output: Number(Math.max(-1, Math.min(1, error * 0.3)).toFixed(3)),
        ok: true,
      });
    }, 900);
    return () => clearInterval(id);
  }, [demoMode, linkStatus]);

  const connect = useCallback(() => {
    if (!activeDrone?.host) return;
    link.connect(activeDrone.host, activeDrone.token || "");
  }, [link, activeDrone]);

  const disconnect = useCallback(() => link.disconnect(), [link]);

  const headingHoldOn = useCallback(() => link.headingHoldOn(), [link]);
  const headingHoldOff = useCallback(() => link.headingHoldOff(), [link]);
  const detectOn = useCallback(() => link.detectOn(), [link]);
  const detectOff = useCallback(() => link.detectOff(), [link]);
  const recordStart = useCallback(() => link.recordStart(), [link]);
  const recordStop = useCallback(() => link.recordStop(), [link]);
  const capturePhoto = useCallback(() => link.photo(), [link]);
  const setAutoRecord = useCallback((on) => link.setAutoRecord(on), [link]);

  // Debounced, recording-safe camera lifecycle. Fully automatic — there is no
  // manual on/off control in the UI. See shouldCameraBeOn below for what it's
  // gated on and why.
  //
  // Commands are TRANSITION-GATED: camera_on is sent only when the desired state
  // genuinely flips off→on (appliedRef), never merely because the effect re-ran.
  // An earlier version called link.cameraOn() unconditionally per effect run with
  // `recording` in the deps, so every server recording toggle / StrictMode remount
  // re-sent camera_on and stormed the Pi with start requests. `recording` is now
  // read through a ref at off-fire time only — it must not re-fire this effect.
  //
  // The OFF is debounced (timer lives here in the persistent provider, not in
  // CameraView) so StrictMode's dev-only mount→cleanup→mount and a quick
  // navigate-away-and-back cancel a pending shutdown instead of churning the Pi
  // camera subprocess. The OFF never fires mid-recording — camera_off kills
  // camera_stream.py and would abort the recording — and re-checks every second so
  // the camera still shuts down once the recording ends.
  const offTimerRef = useRef(null);
  const appliedRef = useRef(null); // last applied state: null | "on" | "off"
  const recordingRef = useRef(false);
  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  // On whenever there is a drone to be on for — not gated on Pixhawk state
  // (tried that; constantly-on is the wanted behavior) and not gated on
  // whether anyone is looking at it either. The latter is deliberate: the
  // object detector's JPEG frame tap lives inside camera_stream.py, so a
  // camera that only ran while a browser had the Control page open meant
  // nothing was detected at any moment nobody happened to be watching — the
  // exact moments an autonomous vehicle most needs to be watched. There is no
  // manual camera button; the only way it goes off is the all-stop kill
  // switch, which also disarms and shuts the server down.
  const shouldCameraBeOn =
    linkStatus === "connected" && !!activeDrone?.camera_url;
  useEffect(() => {
    if (shouldCameraBeOn) {
      clearTimeout(offTimerRef.current); // cancel any pending shutdown
      offTimerRef.current = null;
      if (appliedRef.current !== "on") {
        appliedRef.current = "on";
        link.cameraOn();
      }
      return undefined;
    }
    // Never turned it on → nothing to turn off (don't send camera_off at app boot).
    if (appliedRef.current !== "on") return undefined;
    clearTimeout(offTimerRef.current);
    const fireOff = () => {
      offTimerRef.current = null;
      if (recordingRef.current) {
        // Recording in progress — keep the camera alive, re-check shortly.
        offTimerRef.current = setTimeout(fireOff, 1000);
        return;
      }
      appliedRef.current = "off";
      link.cameraOff();
    };
    offTimerRef.current = setTimeout(fireOff, CAMERA_OFF_DEBOUNCE_MS);
    return () => clearTimeout(offTimerRef.current);
  }, [shouldCameraBeOn, link]);

  // Reconcile the gate above against what the server actually reports. It sends
  // camera_on once per off→on flip, which assumes the start succeeded — and it
  // doesn't always. camera_stream.py can exit at startup (sensor busy, missing
  // dependency; start_camera logs the reason to /tmp/seagrass-camera.log on the
  // Pi), and a reconnect quicker than the off debounce cancels the pending OFF,
  // leaving appliedRef reading "on" against a server that meanwhile restarted
  // with no camera. In both cases the server kept reporting camera:false, the
  // gate had nothing left to fire, and the operator sat in front of a permanent
  // "Camera is off" with nothing retrying short of a page reload.
  //
  // So: while the camera should be on and the server keeps saying it isn't,
  // re-send. The interval resets whenever cameraActive flips, so a start that
  // works ends the retries on the first state message that confirms it.
  useEffect(() => {
    if (!shouldCameraBeOn || cameraActive) return undefined;
    const id = setInterval(() => {
      appliedRef.current = "on";
      link.cameraOn();
    }, CAMERA_RETRY_MS);
    return () => clearInterval(id);
  }, [shouldCameraBeOn, cameraActive, link]);

  // Base URL of the Pi's media server (photos/recordings live on the SD card and
  // are fetched/deleted directly from it, not proxied through the control WS).
  //
  // This used to be the camera stream URL's ORIGIN, on the assumption that one
  // host/port serves both. It does not: the recommended camera URL points at
  // MediaMTX (:8889/cam/whep), which has no /media route, so every listing 404'd
  // and the Media page showed its error state permanently. The media endpoints
  // live in camera_stream.py on :8000. So: take an explicit media_url when set,
  // otherwise keep the camera's HOST but use the media port.
  const mediaBase = useMemo(() => {
    if (activeDrone?.media_url) {
      try {
        return new URL(activeDrone.media_url).origin;
      } catch {
        return null;
      }
    }
    if (!activeDrone?.camera_url) return null;
    try {
      const url = new URL(activeDrone.camera_url);
      url.port = MEDIA_PORT;
      return url.origin;
    } catch {
      return null;
    }
  }, [activeDrone]);

  useEffect(() => () => link.disconnect(false), [link]);

  const value = {
    link,
    fleet,
    fleetLoading,
    refreshFleet,
    saveDrone,
    removeDrone,
    activeDrone,
    selectDrone,
    connect,
    disconnect,
    cameraActive,
    cameraError,
    detectActive,
    detections,
    detectOn,
    detectOff,
    sonar,
    pid,
    headingHold,
    headingHoldOn,
    headingHoldOff,
    recording,
    recElapsed,
    autoRecord,
    recordStart,
    recordStop,
    capturePhoto,
    setAutoRecord,
    mediaBase,
    linkStatus,
    linkDetail,
    armed,
    flightMode,
    pixhawkOk,
    telemetry,
    demoMode,
    setDemoMode,
    toasts,
    pushToast,
    dismissToast,
  };

  return <DroneContext.Provider value={value}>{children}</DroneContext.Provider>;
}

export function useDrone() {
  return useContext(DroneContext);
}
