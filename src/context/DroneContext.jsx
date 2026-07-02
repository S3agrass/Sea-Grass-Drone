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

const LOCAL_DRONE = {
  id: "local",
  name: "Seagrass One",
  host: "ws://seagrass-pi.local:8765",
  camera_url: "http://seagrass-pi.local:8000/stream.mjpg",
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
  const [demoMode, setDemoMode] = useState(
    () => localStorage.getItem("seagrass-demo") === "1",
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
        }
      } else if (event.type === "message") {
        const m = event.data;
        if (m.type === "state") {
          setArmed(Boolean(m.armed));
          if (m.mode) setFlightMode(m.mode);
          setPixhawkOk(Boolean(m.pixhawk));
        } else if (m.type === "telemetry") {
          setTelemetry((t) => ({ ...t, ...m }));
        }
      }
    });
  }, [link]);

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
    }, 900);
    return () => clearInterval(id);
  }, [demoMode, linkStatus]);

  const connect = useCallback(() => {
    if (!activeDrone?.host) return;
    link.connect(activeDrone.host, activeDrone.token || "");
  }, [link, activeDrone]);

  const disconnect = useCallback(() => link.disconnect(), [link]);

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
    linkStatus,
    linkDetail,
    armed,
    flightMode,
    pixhawkOk,
    telemetry,
    demoMode,
    setDemoMode,
  };

  return <DroneContext.Provider value={value}>{children}</DroneContext.Provider>;
}

export function useDrone() {
  return useContext(DroneContext);
}
