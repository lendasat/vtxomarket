"use client";

// Re-export the token page for the dynamic [id] route (dev mode).
// In production (static export), Cloudflare Pages _redirects serves /tokenview instead.
export { default } from "../page";
