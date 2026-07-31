import { useEffect, useRef } from "react";

// Text rendered as particles: the word is drawn to an offscreen canvas, its
// pixels are sampled on a grid, and every opaque hit becomes a dot that springs
// back to where its pixel was. Dots scatter away from the pointer and drift on a
// slow wave the rest of the time.
//
// The colours are SAMPLED FROM THE RASTERISED TEXT rather than set per particle,
// which is what keeps this in step with the CSS: .login-brand is an ink→teal
// gradient, the canvas paints the same gradient, and the dots inherit it. Change
// the CSS and the particles follow; nothing here hardcodes a brand colour.
//
// Everything below is CSS pixels. The canvas backing store is scaled by DPR once
// (setTransform), so no other maths in here has to know about retina.

// Grid step for sampling, in CSS px. 3 is dense enough to keep 56px letterforms
// legible while keeping the particle count in the low thousands — the loop is
// O(particles) per frame and this runs behind a login form, not a game.
const SAMPLE_STEP = 3;

// Physics. Tuned to settle like liquid rather than bounce: a soft spring with
// heavy damping. Raising SPRING without lowering DAMPING gets you a wobble.
const SPRING = 0.06;
const DAMPING = 0.78;
const REPEL_RADIUS = 90; // CSS px
const REPEL_FORCE = 6;
// Repulsion with no jitter looks mechanical — every dot leaves along a perfect
// radius. This scatters each one by its own fixed offset, scaled by how hard it
// was pushed, so the cloud breaks up unevenly the way dust would.
const REPEL_JITTER = 0.9;

// Idle wave, applied AT DRAW TIME only. Keeping it out of the physics matters:
// as a force it would fight the spring and the text would never sit still.
const WAVE_AMPLITUDE = 1.3;
const WAVE_SPEED = 1.1;
const WAVE_FREQ_X = 0.012;
const WAVE_FREQ_Y = 0.01;

const ALPHA_CUTOFF = 40; // out of 255 — below this a pixel is antialiasing fuzz

export default function ParticleTitle({ text, className = "" }) {
  const hostRef = useRef(null);
  const canvasRef = useRef(null);
  const textRef = useRef(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const measure = textRef.current;
    if (!host || !canvas || !measure) return undefined;

    // Respect the OS setting. The effect is decoration on a word that is
    // already legible underneath, so the honest response to reduce-motion is
    // to not run at all rather than to run slower.
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
      return undefined;
    }

    // jsdom and any browser refusing a 2D context land here. The plain text
    // stays visible, which is why it is in the DOM rather than drawn.
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return undefined;

    let particles = [];
    let frame = 0;
    const pointer = { x: -1e4, y: -1e4, active: false };

    const build = () => {
      const rect = host.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      if (w < 2 || h < 2) return;

      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Take the type off the element actually being replaced, so the canvas
      // cannot drift from the stylesheet.
      const cs = getComputedStyle(measure);
      const fontSize = parseFloat(cs.fontSize) || 56;
      const tracking = parseFloat(cs.letterSpacing) || 0;
      ctx.font = `${cs.fontWeight || 800} ${fontSize}px ${cs.fontFamily}`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";

      // Per-character advance rather than one fillText: canvas letterSpacing is
      // not supported everywhere, and .login-brand carries 0.06em of it.
      const chars = [...text];
      const widths = chars.map((c) => ctx.measureText(c).width);
      const total =
        widths.reduce((a, b) => a + b, 0) + tracking * Math.max(0, chars.length - 1);

      // Same gradient as the CSS: ink until 30%, then into teal.
      const startX = Math.max(0, w / 2 - total / 2);
      const grad = ctx.createLinearGradient(startX, 0, startX + total, 0);
      const ink = cs.getPropertyValue("--ink").trim() || "#e9f2f8";
      const teal = cs.getPropertyValue("--teal").trim() || "#3bd9bb";
      grad.addColorStop(0, ink);
      grad.addColorStop(0.3, ink);
      grad.addColorStop(1, teal);
      ctx.fillStyle = grad;

      ctx.clearRect(0, 0, w, h);
      let penX = startX;
      chars.forEach((c, i) => {
        ctx.fillText(c, penX, h / 2);
        penX += widths[i] + tracking;
      });

      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      particles = [];
      for (let y = 0; y < h; y += SAMPLE_STEP) {
        for (let x = 0; x < w; x += SAMPLE_STEP) {
          const px = Math.floor(x * dpr);
          const py = Math.floor(y * dpr);
          const i = (py * canvas.width + px) * 4;
          const alpha = data[i + 3];
          if (alpha <= ALPHA_CUTOFF) continue;
          particles.push({
            tx: x,
            ty: y,
            x,
            y,
            vx: 0,
            vy: 0,
            r: data[i],
            g: data[i + 1],
            b: data[i + 2],
            base: alpha / 255,
            // Deterministic per-particle offset, so the twinkle and the scatter
            // never march in lockstep. Same hash constants as the GLSL idiom.
            phase: (x * 12.9898 + y * 78.233) % 6.283,
          });
        }
      }
      ctx.clearRect(0, 0, w, h);
      // The rasterised word has done its job as a source of positions and
      // colours; from here the dots are the only thing drawn.
      measure.style.visibility = "hidden";
    };

    const draw = (now) => {
      const t = now / 1000;
      const rect = host.getBoundingClientRect();
      ctx.clearRect(0, 0, rect.width, rect.height);

      for (const p of particles) {
        p.vx += (p.tx - p.x) * SPRING;
        p.vy += (p.ty - p.y) * SPRING;

        if (pointer.active) {
          const dx = p.x - pointer.x;
          const dy = p.y - pointer.y;
          const distSq = dx * dx + dy * dy;
          if (distSq < REPEL_RADIUS * REPEL_RADIUS) {
            const dist = Math.sqrt(distSq) || 1;
            const force = (1 - dist / REPEL_RADIUS) * REPEL_FORCE;
            p.vx += (dx / dist) * force + ((p.phase % 1) - 0.5) * force * REPEL_JITTER;
            p.vy +=
              (dy / dist) * force + (((p.phase * 1.7) % 1) - 0.5) * force * REPEL_JITTER;
          }
        }

        p.vx *= DAMPING;
        p.vy *= DAMPING;
        p.x += p.vx;
        p.y += p.vy;

        const wave =
          Math.sin(t * WAVE_SPEED - p.tx * WAVE_FREQ_X + p.ty * WAVE_FREQ_Y) *
          WAVE_AMPLITUDE;
        const twinkle = 0.86 + 0.14 * Math.sin(t * 2.1 + p.phase);

        ctx.beginPath();
        ctx.arc(p.x, p.y + wave, 1.35 * (0.6 + p.base * 0.4), 0, 6.2832);
        ctx.fillStyle = `rgba(${p.r},${p.g},${p.b},${Math.min(
          1,
          (0.72 + p.base * 0.38) * twinkle,
        ).toFixed(3)})`;
        ctx.fill();
      }
      frame = requestAnimationFrame(draw);
    };

    const onPointerMove = (e) => {
      const rect = host.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
      pointer.active = true;
    };
    const onPointerLeave = () => {
      pointer.active = false;
      pointer.x = -1e4;
      pointer.y = -1e4;
    };

    build();
    frame = requestAnimationFrame(draw);

    // Rebuild on resize: the particle homes are absolute positions, so a
    // reflow without this leaves the word anchored to the old box.
    const ro = new ResizeObserver(build);
    ro.observe(host);
    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerleave", onPointerLeave);

    // Webfonts land after first paint. Sampling before Sora arrives rasterises
    // the fallback face, and the dots would spell the word in the wrong type.
    document.fonts?.ready?.then(build).catch(() => {});

    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerleave", onPointerLeave);
      if (measure) measure.style.visibility = "";
    };
  }, [text]);

  return (
    <div ref={hostRef} className={`particle-title ${className}`}>
      {/* Real text, always in the DOM: it is what screen readers announce, what
          a selection copies, and what stays on screen when the effect does not
          run (reduced motion, no 2D context). The canvas only hides it once it
          has something to show. */}
      <span ref={textRef} className="particle-title-text">
        {text}
      </span>
      <canvas ref={canvasRef} className="particle-title-canvas" aria-hidden="true" />
    </div>
  );
}
