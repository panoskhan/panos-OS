import { useEffect, useRef } from "react";

interface Planet {
  id: string;
  label: string;
  ring: number;
  phase: number;
  color: string;
}

const RINGS = [0.44, 0.7, 0.96]; // fraction of the maximum orbit size
const SPEEDS = [0.34, 0.23, 0.16]; // radians per second, inner rings faster
const PLANETS: Planet[] = [
  { id: "planner", label: "Planner", ring: 0, phase: 0.4, color: "#00C8FF" },
  { id: "router", label: "Model Router", ring: 0, phase: 0.4 + Math.PI, color: "#38BDF8" },
  { id: "permissions", label: "Permissions", ring: 1, phase: 1.5, color: "#F59E0B" },
  { id: "qa", label: "QA", ring: 1, phase: 1.5 + Math.PI, color: "#22C55E" },
  { id: "files", label: "Files", ring: 2, phase: 2.6, color: "#67E8F9" },
  { id: "coding", label: "Coding", ring: 2, phase: 2.6 + Math.PI, color: "#93C5FD" }
];

interface Scene {
  active: ReadonlySet<string>;
  busy: boolean;
}

interface Star {
  x: number;
  y: number;
  size: number;
  alpha: number;
}

function makeStars(width: number, height: number): Star[] {
  let seed = 7;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  return Array.from({ length: 70 }, () => ({
    x: random() * width,
    y: random() * height,
    size: random() < 0.15 ? 1.6 : 1,
    alpha: 0.15 + random() * 0.35
  }));
}

function glow(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string, alpha: number) {
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, `${color}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`);
  gradient.addColorStop(1, `${color}00`);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawScene(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  time: number,
  scene: Scene,
  stars: Star[]
) {
  ctx.clearRect(0, 0, width, height);
  const cx = width / 2;
  const cy = height / 2;
  const maxRx = width * 0.44;
  const maxRy = height * 0.4;

  for (const star of stars) {
    ctx.fillStyle = `rgba(159, 233, 255, ${star.alpha})`;
    ctx.fillRect(star.x, star.y, star.size, star.size);
  }

  ctx.lineWidth = 1;
  for (const ring of RINGS) {
    ctx.strokeStyle = "#162240";
    ctx.beginPath();
    ctx.ellipse(cx, cy, maxRx * ring, maxRy * ring, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Core
  const pulse = scene.busy ? 0.5 + 0.5 * Math.sin(time * 4) : 0.35;
  const coreRadius = Math.min(width, height) * 0.085;
  glow(ctx, cx, cy, coreRadius * (3 + pulse), "#00C8FF", 0.45 + pulse * 0.25);
  const core = ctx.createRadialGradient(cx - coreRadius * 0.3, cy - coreRadius * 0.35, 1, cx, cy, coreRadius);
  core.addColorStop(0, "#ffffff");
  core.addColorStop(0.35, "#7de3ff");
  core.addColorStop(1, "#0077b6");
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(cx, cy, coreRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#01121f";
  ctx.font = "700 10px 'Space Grotesk', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("KHAN", cx, cy + 0.5);

  // Planets
  ctx.font = "500 11px 'Space Grotesk', sans-serif";
  for (const planet of PLANETS) {
    const angle = planet.phase + time * SPEEDS[planet.ring];
    const x = cx + Math.cos(angle) * maxRx * RINGS[planet.ring];
    const y = cy + Math.sin(angle) * maxRy * RINGS[planet.ring];
    const active = scene.active.has(planet.id);
    const radius = active ? 8 : 6;

    glow(ctx, x, y, radius * (active ? 4.5 : 2.6), planet.color, active ? 0.75 : 0.28);
    ctx.fillStyle = planet.color;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    if (active) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, radius + 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    ctx.fillStyle = active ? "#ffffff" : "#8aa0bd";
    ctx.textBaseline = "top";
    ctx.fillText(planet.label, x, y + radius + 5);
  }
}

interface OrbitalCanvasProps {
  /** Agent ids (planner, router, permissions, qa, files, coding) that are working right now. */
  active: ReadonlySet<string>;
  busy: boolean;
}

export function OrbitalCanvas({ active, busy }: OrbitalCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<Scene>({ active, busy });
  const repaintRef = useRef<() => void>(() => {});

  useEffect(() => {
    sceneRef.current = { active, busy };
    repaintRef.current();
  }, [active, busy]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const startedAt = performance.now();
    let width = 0;
    let height = 0;
    let stars: Star[] = [];
    let frame = 0;

    const paint = () => {
      const time = reducedMotion.matches ? 0 : (performance.now() - startedAt) / 1000;
      drawScene(ctx, width, height, time, sceneRef.current, stars);
    };
    const tick = () => {
      paint();
      frame = requestAnimationFrame(tick);
    };
    const restart = () => {
      cancelAnimationFrame(frame);
      if (reducedMotion.matches) paint();
      else frame = requestAnimationFrame(tick);
    };
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stars = makeStars(width, height);
      paint();
    };

    repaintRef.current = paint;
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    reducedMotion.addEventListener("change", restart);
    resize();
    restart();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      reducedMotion.removeEventListener("change", restart);
      repaintRef.current = () => {};
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="orbit"
      role="img"
      aria-label="KHAN OS core orbited by six agents: Planner, Model Router, Permissions, QA, Files and Coding"
    />
  );
}
