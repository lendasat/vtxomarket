"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import type { Trade } from "@/hooks/useTrades";

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

function getIntervalSec(tf: Timeframe): number {
  switch (tf) {
    case "1m":
      return 60;
    case "5m":
      return 300;
    case "15m":
      return 900;
    case "1H":
      return 3600;
    case "4H":
      return 14400;
    case "1D":
      return 86400;
  }
}

/** Aggregate trade receipts into candles */
function aggregateTrades(
  trades: Trade[],
  intervalSec: number,
  basePrice: number
): { candles: CandleData[]; volumes: VolumeData[] } {
  if (trades.length === 0) {
    // Generate a flat line at basePrice if no trades
    const candles: CandleData[] = [];
    const volumes: VolumeData[] = [];
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 20; i++) {
      const time = now - (20 - i) * intervalSec;
      candles.push({ time, open: basePrice, high: basePrice, low: basePrice, close: basePrice });
      volumes.push({ time, value: 0, color: "rgba(52, 211, 153, 0.2)" });
    }
    return { candles, volumes };
  }

  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  const buckets = new Map<number, Trade[]>();

  for (const trade of sorted) {
    const bucket = Math.floor(trade.timestamp / intervalSec) * intervalSec;
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket)!.push(trade);
  }

  const candles: CandleData[] = [];
  const volumes: VolumeData[] = [];
  let lastClose = sorted[0].price;

  const sortedBuckets = [...buckets.entries()].sort(([a], [b]) => a - b);

  for (const [time, bucketTrades] of sortedBuckets) {
    const prices = bucketTrades.map((t) => t.price);
    const open = lastClose;
    const close = prices[prices.length - 1];
    const high = Math.max(open, close, ...prices);
    const low = Math.min(open, close, ...prices);
    const vol = bucketTrades.reduce((s, t) => s + t.satAmount, 0);

    candles.push({
      time,
      open: +open.toFixed(6),
      high: +high.toFixed(6),
      low: +low.toFixed(6),
      close: +close.toFixed(6),
    });

    volumes.push({
      time,
      value: vol,
      color: close >= open ? "rgba(52, 211, 153, 0.4)" : "rgba(248, 113, 113, 0.4)",
    });

    lastClose = close;
  }

  return { candles, volumes };
}

interface TokenChartProps {
  trades?: Trade[];
  basePrice: number;
}

export function TokenChart({ trades = [], basePrice }: TokenChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof import("lightweight-charts").createChart> | null>(null);
  const [tf, setTf] = useState<Timeframe>("5m");

  const { candles, volumes } = useMemo(
    () => aggregateTrades(trades, getIntervalSec(tf), basePrice),
    [trades, tf, basePrice]
  );

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;

    (async () => {
      const { createChart, CandlestickSeries, HistogramSeries, ColorType } =
        await import("lightweight-charts");

      if (disposed || !containerRef.current) return;

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

      candleSeries.setData(candles as Parameters<typeof candleSeries.setData>[0]);
      volumeSeries.setData(volumes as Parameters<typeof volumeSeries.setData>[0]);

      chart.timeScale().fitContent();

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
  }, [tf, candles, volumes]);

  return (
    <div>
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
      <div
        ref={containerRef}
        className="w-full h-[260px] sm:h-[320px] lg:h-[360px] rounded-lg overflow-hidden"
      />
    </div>
  );
}
