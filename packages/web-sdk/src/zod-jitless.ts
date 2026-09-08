import { config as configureZod } from "zod/v4/core";

// AI SDK's Zod schemas otherwise probe `new Function` at module evaluation.
// That probe is caught by Zod but still violates an application's restrictive
// CSP. Configure the shared Zod runtime before any SDK dependency is evaluated.
// This trades Zod's schema JIT performance for a browser-safe package import.
configureZod({ jitless: true });
