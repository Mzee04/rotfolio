import { useEffect, useRef } from "react";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LABELS = DAYS.flatMap((day) => [`${day} AM`, `${day} PM`]);

export function tickLabel(tick: number) {
  if (tick <= 0) return "Sunday";
  return LABELS[tick - 1] ?? "Rot Sunday";
}

export function Chart({ prices, color = "#fac464", compact = false }: {
  prices: number[]; color?: string; compact?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    const context = target.getContext("2d");
    if (!context) return;

    const draw = () => {
      const { width, height } = target.getBoundingClientRect();
      if (!width || !height) return;
      const ratio = window.devicePixelRatio || 1;
      target.width = width * ratio;
      target.height = height * ratio;
      context.scale(ratio, ratio);
      const left = 35;
      const right = width - 12;
      const top = 13;
      const bottom = height - 38;
      const maximum = Math.max(150, Math.ceil(Math.max(0, ...prices) / 150) * 150);
      const x = (index: number) => left + ((right - left) * index) / 11;
      const y = (price: number) => bottom - ((bottom - top) * price) / maximum;

      context.font = "11px system-ui";
      context.fillStyle = "#afbed6";
      context.textAlign = "right";
      for (let step = 0; step <= 3; step++) {
        const price = maximum * step / 3;
        const row = y(price);
        context.strokeStyle = "#ffffff22";
        context.beginPath();
        context.moveTo(left, row);
        context.lineTo(right, row);
        context.stroke();
        context.fillText(String(price), left - 7, row + 4);
      }
      context.textAlign = "center";
      const showPeriods = !compact && width > 235;
      DAYS.forEach((day, index) => {
        const center = (x(index * 2) + x(index * 2 + 1)) / 2;
        context.fillText(day, Math.min(right - 6, center), height - (showPeriods ? 20 : 10));
        if (showPeriods) {
          context.fillText("AM", x(index * 2), height - 4);
          context.fillText("PM", x(index * 2 + 1), height - 4);
        }
      });

      if (prices.length === 0) return;
      if (prices.length > 1) {
        const area = context.createLinearGradient(0, top, 0, bottom);
        area.addColorStop(0, `${color}54`);
        area.addColorStop(1, `${color}03`);
        context.beginPath();
        context.moveTo(x(0), bottom);
        prices.forEach((price, index) => context.lineTo(x(index), y(price)));
        context.lineTo(x(prices.length - 1), bottom);
        context.closePath();
        context.fillStyle = area;
        context.fill();

        context.beginPath();
        prices.forEach((price, index) => {
          if (index === 0) context.moveTo(x(index), y(price));
          else context.lineTo(x(index), y(price));
        });
        context.lineWidth = 2;
        context.lineJoin = "round";
        context.strokeStyle = color;
        context.stroke();
      }
      prices.forEach((price, index) => {
        context.beginPath();
        context.arc(x(index), y(price), index === prices.length - 1 ? 4 : 2.5, 0, Math.PI * 2);
        context.fillStyle = color;
        context.fill();
      });
    };
    const observer = new ResizeObserver(draw);
    observer.observe(target);
    draw();
    return () => observer.disconnect();
  }, [prices, color, compact]);

  const label = prices.length
    ? prices.map((price, index) => `${LABELS[index]} ${price} coins`).join(", ")
    : "No trading ticks yet";
  return <canvas ref={canvas} className={compact ? "chart compact" : "chart"} role="img" aria-label={label} />;
}
