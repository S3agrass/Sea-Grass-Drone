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

const LOCAL_DRONE = {
  id: "local",
  name: "Seagrass One",
  host: "ws://seagrass-pi.local:8765",
  camera_url: "",
  token: "",
};

function loadLocalFleet() {
  try {
    const raw = localStorage.getItem("seagrass-fleet");
    const fleet = raw ? JSON.parse(raw) : null;
    return Array.isArray(fleet) && fleet.length ? fleet : [LOCAL_DRONE];
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
  });
  // Ping2 sonar: forward/obstacle distance + how much the echosounder trusts it.
  // ok flips the gauge from a calm "—" to a live value; distance is in metres.
  const [sonar, setSonar] = useState({
    distance_m: null,
    confidence: null,
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
  // Set true while the Control screen's CameraView is mounted — drives the
  // debounced auto on/off lifecycle below.
  const [cameraViewing, setCameraViewing] = useState(false);
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
          setSonar({ distance_m: null, confidence: null, ok: false });
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
            confidence: m.confidence ?? null,
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
    const id = setInterval(() => {
      heading = (heading + (Math.random() * 6 - 3) + 360) % 360;
      setTelemetry((t) => ({
        ...t,
        heading,
        groundspeed: 1.6 + Math.random() * 0.8,
        battery: 82,
        depth: 0.4 + Math.random() * 0.2,
      }));
      // Simulated submerged sonar: a wandering forward distance with a healthy
      // confidence, so the gauge previews live-looking data with no hardware.
      setSonar({
        distance_m: Number((2.5 + Math.random() * 1.5).toFixed(2)),
        confidence: Math.round(55 + Math.random() * 35),
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

  const shouldCameraBeOn =
    linkStatus === "connected" && !!activeDrone?.camera_url && cameraViewing;
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
    recording,
    recElapsed,
    autoRecord,
    recordStart,
    recordStop,
    capturePhoto,
    setAutoRecord,
    setCameraViewing,
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
