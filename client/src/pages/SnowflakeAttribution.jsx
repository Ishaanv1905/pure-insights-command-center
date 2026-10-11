/** Snowflake attribution tab on the Cost page. The SQL suite lives in snowflake/ (Task 3). */
export default function SnowflakeAttribution() {
  return (
    <p className="panel-body muted">
      Snowflake credit attribution per report is produced by the SQL suite in the <code>snowflake/</code> folder of this
      project. See <code>snowflake/README.md</code> for the method and results, and{' '}
      <code>snowflake/output/attribution_results.json</code> for the full output.
    </p>
  );
}
