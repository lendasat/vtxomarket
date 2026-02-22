"use client";

import { useEffect, useRef, useState } from "react";

type Timeframe = "1m" | "5m" | "15m" | "1H" | "4H" | "1D";

const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1H", "4H", "1D"];

interface CandleData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface VolumeData {
  time: number;
  value: number;
  color: string;
}

/** Generate mock OHLC data around a base price */
function generateMockCandles(
  basePrice: number,
  count: number,
  intervalSec: number
): { candles: CandleData[]; volumes: VolumeData[] } {
  const candles: CandleData[] = [];
  const volumes: VolumeData[] = [];
  const now = Math.floor(Date.now() / 1000);
  let price = basePrice * 0.3; // start low, trend up

  for (let i = 0; i < count; i++) {
    const time = now - (count - i) * intervalSec;
    const volatility = basePrice * 0.08;
    const trend = (basePrice - price) * 0.02; // mean-revert toward base
    const open = price;
    const change1 = (Math.random() - 0.45) * volatility + trend;
    const change2 = (Math.random() - 0.45) * volatility + trend;
    const close = Math.max(0.001, open + change1);
    const high = Math.max(open, close) + Math.abs(change2) * 0.5;
    const low = Math.min(open, close) - Math.abs(change2) * 0.3;

    candles.push({
      time,
      open: +open.toFixed(4),
      high: +high.toFixed(4),
      low: +Math.max(0.001, low).toFixed(4),
      close: +close.toFixed(4),
    });

    const vol = Math.random() * 5000 + 500;
    volumes.push({
      time,
      value: +vol.toFixed(0),
      color: close >= open ? "rgba(52, 211, 153, 0.4)" : "rgba(248, 113, 113, 0.4)",
    });

    price = close;
  }

  return { candles, volumes };
}

function getIntervalSec(tf: Timeframe): number {
  switch (tf) {
    case "1m": return 60;
    case "5m": return 300;
    case "15m": return 900;
    case "1H": return 3600;
    case "4H": return 14400;
    case "1D": return 86400;
  }
}

export function TokenChart({ basePrice }: { basePrice: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof import("lightweight-charts").createChart> | null>(null);
  const [tf, setTf] = useState<Timeframe>("5m");

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;

    (async () => {
      const { createChart, CandlestickSeries, HistogramSeries, ColorType } = await import("lightweight-charts");

      if (disposed || !containerRef.current) return;

      // Clear previous chart
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }

      const chart = createChart(containerRef.current, {
        layout: {
          background: { type: ColorType.Solid, color: "transparent" },
          textColor: "rgba(255,255,255,0.5)",
          fontSize: 11,
        },
        grid: {
          vertLines: { color: "rgba(255,255,255,0.04)" },
          horzLines: { color: "rgba(255,255,255,0.04)" },
        },
        crosshair: {
          vertLine: { color: "rgba(255,255,255,0.1)", width: 1, labelBackgroundColor: "#1a1a1a" },
          horzLine: { color: "rgba(255,255,255,0.1)", width: 1, labelBackgroundColor: "#1a1a1a" },
        },
        rightPriceScale: {
          borderColor: "rgba(255,255,255,0.06)",
        },
        timeScale: {
          borderColor: "rgba(255,255,255,0.06)",
          timeVisible: true,
          secondsVisible: false,
        },
        handleScale: { axisPressedMouseMove: true },
        handleScroll: { vertTouchDrag: false },
      });

      chartRef.current = chart;

      const candleSeries = chart.addSeries(CandlestickSeries, {
        upColor: "#34d399",
        downColor: "#f87171",
        borderUpColor: "#34d399",
        borderDownColor: "#f87171",
        wickUpColor: "#34d39988",
        wickDownColor: "#f8717188",
      });

      const volumeSeries = chart.addSeries(HistogramSeries, {
        priceFormat: { type: "volume" },
        priceScaleId: "",
      });
      volumeSeries.priceScale().applyOptions({
        scaleMargins: { top: 0.85, bottom: 0 },
      });

      const intervalSec = getIntervalSec(tf);
      const count = tf === "1D" ? 60 : tf === "4H" ? 48 : tf === "1H" ? 72 : 100;
      const { candles, volumes } = generateMockCandles(basePrice, count, intervalSec);

      candleSeries.setData(candles as Parameters<typeof candleSeries.setData>[0]);
      volumeSeries.setData(volumes as Parameters<typeof volumeSeries.setData>[0]);

      chart.timeScale().fitContent();

      // Resize observer
      const resizeObserver = new ResizeObserver(() => {
        if (containerRef.current && chartRef.current) {
          const { width, height } = containerRef.current.getBoundingClientRect();
          chartRef.current.applyOptions({ width, height });
        }
      });
      resizeObserver.observe(containerRef.current);

      return () => {
        resizeObserver.disconnect();
      };
    })();

    return () => {
      disposed = true;
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
    };
  }, [tf, basePrice]);

  return (
    <div>
      {/* Timeframe selector */}
      <div className="flex items-center gap-0.5 sm:gap-1 mb-3 overflow-x-auto">
        {TIMEFRAMES.map((t) => (
          <button
            key={t}
            onClick={() => setTf(t)}
            className={`shrink-0 px-2 sm:px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all ${
              tf === t
                ? "bg-white/[0.1] text-foreground shadow-sm"
                : "text-muted-foreground/50 hover:text-muted-foreground/70 hover:bg-white/[0.04]"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      {/* Chart container — shorter on mobile */}
      <div ref={containerRef} className="w-full h-[260px] sm:h-[320px] lg:h-[360px] rounded-lg overflow-hidden" />
    </div>
  );
}
