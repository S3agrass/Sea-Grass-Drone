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

// The Pi serves MJPEG from a fixed, known place — camera_stream.py binds
// ('', 8000) and routes /stream.mjpg — so there is no reason for this to have
// shipped blank. It did, and a blank camera_url is indistinguishable from a
// deliberate one: no feed renders, and `shouldCameraBeOn` stays false so the
// camera never even starts. The operator sees a dead panel with nothing
// anywhere explaining that a field they have never been shown is empty.
export const DEFAULT_CAMERA_URL = "http://seagrass.local:8000/stream.mjpg";

const LOCAL_DRONE = {
  id: "local",
  name: "Seagrass One",
  host: "ws://seagrass.local:8765",
  camera_url: DEFAULT_CAMERA_URL,
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
    if (typeof d?.host === "string" && d.host.includes(DEAD_HOST)) {
      changed = true;
      next = { ...next, host: d.host.replaceAll(DEAD_HOST, LIVE_HOST) };
    }
    // Same class of problem as the dead host: a wrong shipped default that
    // localStorage then pins forever. Filling a BLANK one in is safe because
    // blank has no behaviour to preserve — it renders no feed and blocks the
    // camera from starting. Anything the operator actually set, including a
    // tunnelled or custom address, is left strictly alone.
    if (!d?.camera_url) {
      changed = true;
      next = { ...next, camera_url: DEFAULT_CAMERA_URL };
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
  const refreshFleet = useCallback(async () => {
    setFleetLoading(true);
    if (supabaseConfigured && user) {
      const { data, error } = await supabase
        .from("drones")
        .select("*")
        .order("created_at", { ascending: true });
      if (!error && data) setFleet(data);
      else setFleet([]);
    } else if (localMode) {
      setFleet(loadLocalFleet());
    } else {
      setFleet([]);
    }
    setFleetLoading(false);
  }, [user, localMode]);

  useEffect(() => {
    refreshFleet();
  }, [refreshFleet]);

  const saveDrone = useCallback(
    async (drone) => {
      if (supabaseConfigured && user) {
        const row = {
          name: drone.name,
          host: drone.host,
          camera_url: drone.camera_url,
          token: drone.token ?? "",
          owner: user.id,
        };
        if (drone.id && drone.id !== "new") {
          await supabase.from("drones").update(row).eq("id", drone.id);
        } else {
          await supabase.from("drones").insert(row);
        }
        await refreshFleet();
      } else {
        setFleet((prev) => {
          const next =
            drone.id && drone.id !== "new"
              ? prev.map((d) => (d.id === drone.id ? { ...d, ...drone } : d))
              : [...prev, { ...drone, id: `local-${Date.now()}` }];
          localStorage.setItem("seagrass-fleet", JSON.stringify(next));
          return next;
        });
      }
    },
    [user, refreshFleet],
  );

  const removeDrone = useCallback(
    async (id) => {
      if (supabaseConfigured && user) {
        await supabase.from("drones").delete().eq("id", id);
        await refreshFleet();
      } else {
        setFleet((prev) => {
          const next = prev.filter((d) => d.id !== id);
          localStorage.setItem("seagrass-fleet", JSON.stringify(next));
          return next;
        });
      }
    },
    [user, refreshFleet],
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
  const cameraOn = useCallback(() => link.cameraOn(), [link]);
  const cameraOff = useCallback(() => link.cameraOff(), [link]);
  const detectOn = useCallback(() => link.detectOn(), [link]);
  const detectOff = useCallback(() => link.detectOff(), [link]);
  const recordStart = useCallback(() => link.recordStart(), [link]);
  const recordStop = useCallback(() => link.recordStop(), [link]);
  const capturePhoto = useCallback(() => link.photo(), [link]);
  const setAutoRecord = useCallback((on) => link.setAutoRecord(on), [link]);

  // Debounced, recording-safe camera lifecycle. The camera should be on whenever
  // the operator is viewing it (CameraView mounted) on a connected drone that has a
  // stream URL — giving instant footage — and off shortly after they leave.
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

  // On whenever there is a drone to be on for — no longer gated on whether
  // anyone is looking at it.
  //
  // It used to track a `cameraViewing` flag that CameraView set on mount and
  // cleared on unmount, so navigating off the Control page sent camera_off: an
  // automatic kill switch nobody asked for, and one the detector cannot
  // survive, because the JPEG frame tap lives inside camera_stream.py and
  // closing the tab therefore stopped detection too. The flag and its setter
  // are gone rather than left in place unread — nothing consumed them once this
  // stopped, and keeping them would have re-rendered the whole provider on
  // every navigation to update state no one looked at.
  //
  // The manual toggle still turns it off, and the all-stop kill switch still
  // takes it down; what went away is anything doing so on its own.
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

  // Base URL of the Pi's media server (photos/recordings live on the SD card and
  // are fetched/deleted directly from it, not proxied through the control WS).
  // Derived from the camera stream URL's origin — same host/port serves both.
  const mediaBase = useMemo(() => {
    if (!activeDrone?.camera_url) return null;
    try {
      return new URL(activeDrone.camera_url).origin;
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
    cameraOn,
    cameraOff,
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
