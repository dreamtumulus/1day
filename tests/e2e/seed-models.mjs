// Stable local test prices/models, independent of changes to the public catalog.
// Called only by run.sh after it creates its disposable DATA_DIR.
if (process.env.E2E_FIXTURE !== "1" || !process.env.DATA_DIR || process.env.DB_PATH) {
  throw new Error("E2E model fixtures require the runner's isolated DATA_DIR");
}
const { run, tx } = await import("../../packages/core/dist/index.js");
tx(() => {
  for (const [id, platform, input, output, read, write] of [
    ["claude-sonnet-5", "anthropic", 3, 15, 0.3, 3.75],
    ["gpt-5.5", "openai", 1.25, 10, 0.125, 1.25],
  ]) {
    run(`INSERT INTO model_prices(model_id,display_name,platform,input_per_m,output_per_m,cache_read_per_m,cache_write_per_m,enabled)
      VALUES (?,?,?,?,?,?,?,1) ON CONFLICT(model_id) DO UPDATE SET
        input_per_m=excluded.input_per_m,output_per_m=excluded.output_per_m,
        cache_read_per_m=excluded.cache_read_per_m,cache_write_per_m=excluded.cache_write_per_m,enabled=1`,
    id, `E2E ${id}`, platform, input, output, read, write);
  }
});
