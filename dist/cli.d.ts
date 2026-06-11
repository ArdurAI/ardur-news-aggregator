/**
 * CLI — run one aggregation cycle and write the artifact to stdout or a file.
 *
 * Usage:
 *   npm run aggregate                             # → stdout (ETL off)
 *   npm run aggregate -- --out data/golden-sample.json
 *   npm run aggregate -- --etl                    # enable full ETL
 *   npm run aggregate -- --max-age-hours 48 --timeout 10000
 *   ARDUR_ETL_ENABLED=true npm run aggregate      # enable ETL via env
 */
export {};
