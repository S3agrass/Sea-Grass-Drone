import { useCallback, useEffect, useRef, useState } from "react";
import { useDrone } from "../context/DroneContext";

const LOW_BATTERY = 25;

function fmt(value, unit, digits = 1) {
  if (value == null || Number.isNaN(value)) return "unknown";
  return `${Number(value).toFixed(digits)} ${unit}`;
}

/**
 * The screen reader's version of the instrument cluster.
 *
 * The deck renders depth, battery, attitude, sonar range and PID error as text
 * that changes several times a second. None of it was announced, so a blind
 * operator flew with no telemetry at all — but the naive fix is worse than the
 * bug: wrapping live numbers in aria-live produces speech that never stops and
 * never lets the user hear anything else, including the alerts that matter.
 * WCAG asks for the information to be available, not for it to be shouted.
 *
 * So this splits into two channels:
 *
 *   1. On demand — "Read flight status" (or Alt+S) composes one sentence with
 *      everything and drops it into a polite region. Nothing is spoken until
 *      the operator asks, and asking is one keystroke.
 *   2. Edge-triggered alerts — only when a value CROSSES something that
 *      matters: armed/disarmed, link up/down, heartbeat lost, battery entering
 *      low, recording starting or stopping. Each fires once per transition and
 *      stays quiet while the state holds, so "ARMED" is spoken when it becomes
 *      true and not sixty times a minute thereafter.
 *
 * Arm state is the reason this is assertive rather than polite: the difference
 * between armed and disarmed thrusters is the difference between a vehicle that
 * will move and one that will not, and it is not something to queue behind
 * whatever else is being read.
 */
export default function FlightStatus() {
  const { armed, linkStatus, pixhawkOk, recording, telemetry, sonar, activeDrone } =
    useDrone();

  const [alert, setAlert] = useState("");
  const [summary, setSummary] = useState("");

  // Previous values, for edge detection. Seeded on the first run so mounting
  // the deck does not announce the state it started in as though it had just
  // changed.
  const prev = useRef(null);

  useEffect(() => {
    const now = {
      armed,
      connected: linkStatus === "connected",
      pixhawkOk,
      recording,
      lowBattery: telemetry.battery != null && telemetry.battery <= LOW_BATTERY,
    };

    if (prev.current === null) {
      prev.current = now;
      return;
    }

    const was = prev.current;
    const messages = [];

    if (now.connected !== was.connected) {
      messages.push(now.connected ? "Drone link established." : "Drone link lost.");
    }
    if (now.armed !== was.armed) {
      messages.push(now.armed ? "Thrusters armed." : "Thrusters disarmed.");
    }
    // Only meaningful while connected — losing the heartbeat because the whole
    // link went down is already covered by the link message above, and saying
    // both is just noise.
    if (now.connected && was.connected && now.pixhawkOk !== was.pixhawkOk) {
      messages.push(
        now.pixhawkOk ? "Pixhawk heartbeat restored." : "Pixhawk heartbeat lost.",
      );
    }
    if (now.recording !== was.recording) {
      messages.push(now.recording ? "Recording started." : "Recording stopped.");
    }
    // One-way: announced on the way into low battery, not on every wobble back
    // and forth across the threshold as the reading fluctuates.
    if (now.lowBattery && !was.lowBattery) {
      messages.push(`Battery low, ${Math.round(telemetry.battery)} percent.`);
    }

    prev.current = now;

    if (messages.length > 0) {
      // Re-setting an identical string does not re-announce it, because the
      // DOM text never changes. A trailing space toggled per message forces a
      // mutation for repeats like arm/disarm/arm.
      setAlert((current) => {
        const next = messages.join(" ");
        return current.trimEnd() === next ? `${next} ` : next;
      });
    }
  }, [armed, linkStatus, pixhawkOk, recording, telemetry.battery]);

  const readStatus = useCallback(() => {
    const connected = linkStatus === "connected";
    if (!connected) {
      setSummary(
        `${activeDrone?.name || "Drone"} not connected. Link status: ${linkStatus}.`,
      );
      return;
    }
    const parts = [
      `${activeDrone?.name || "Drone"}.`,
      armed ? "Thrusters armed." : "Thrusters disarmed.",
      pixhawkOk ? "Heartbeat OK." : "No heartbeat.",
      `Depth ${fmt(telemetry.depth, "metres")}.`,
      `Altitude ${fmt(telemetry.altitude, "metres")}.`,
      `Climb rate ${fmt(telemetry.climb, "metres per second")}.`,
      `Speed ${fmt(telemetry.groundspeed, "metres per second")}.`,
      `Heading ${telemetry.heading == null ? "unknown" : `${Math.round(telemetry.heading)} degrees`}.`,
      `Roll ${fmt(telemetry.roll, "degrees", 0)}, pitch ${fmt(telemetry.pitch, "degrees", 0)}.`,
      `Battery ${telemetry.battery == null ? "unknown" : `${Math.round(telemetry.battery)} percent`}.`,
      sonar?.distance_m == null
        ? "Sonar: no return."
        : `Sonar range ${fmt(sonar.distance_m, "metres")}, ${sonar.quality} lock.`,
      recording ? "Recording." : "Not recording.",
    ];
    // Same trick as above: an unchanged summary would not be re-announced when
    // the operator presses the key twice, which reads as the control being
    // broken.
    setSummary((current) => {
      const next = parts.join(" ");
      return current.trimEnd() === next ? `${next} ` : next;
    });
  }, [
    activeDrone,
    armed,
    linkStatus,
    pixhawkOk,
    recording,
    sonar,
    telemetry,
  ]);

  // Alt+S. Alt rather than a bare key because the deck has single-key thruster
  // controls; Alt-modified combinations are not claimed by the gamepad helm.
  useEffect(() => {
    const onKey = (event) => {
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        readStatus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [readStatus]);

  return (
    <div className="flight-status">
      {/* Both regions are always mounted and start empty. A live region that is
          inserted at the same moment as its text is announced unreliably — the
          container has to be there first for the change to be observed. */}
      <div role="alert" aria-live="assertive" className="visually-hidden">
        {alert}
      </div>
      <div role="status" aria-live="polite" className="visually-hidden">
        {summary}
      </div>
      <button className="btn btn-ghost flight-status-btn" onClick={readStatus}>
        Read flight status
        <span className="visually-hidden"> (Alt plus S)</span>
      </button>
    </div>
  );
}
