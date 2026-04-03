import { startPipeline } from "./pipeline.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  let shutdown: (() => Promise<void>) | null = null;

  try {
    shutdown = await startPipeline();
  } catch (err) {
    logger.error({ err }, "Pipeline: startup failed");
    process.exit(1);
  }

  // Graceful shutdown on SIGINT/SIGTERM
  const handleSignal = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Pipeline: received signal, shutting down");
    if (shutdown) {
      await shutdown();
    }
    process.exit(0);
  };

  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));

  logger.info("Pipeline: running (press Ctrl+C to stop)");
}

main().catch((err) => {
  logger.error({ err }, "Unhandled error");
  process.exit(1);
});
