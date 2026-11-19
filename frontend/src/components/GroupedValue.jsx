// #1832 — long hashes and addresses are hard to compare when they wrap as one
// unbroken run. Render them in groups of four characters for visual comparison.
// The grouped copy is hidden from assistive tech; a screen reader reads the full
// value from the sr-only copy, with a pause between groups.
const GROUP_SIZE = 4;

export function groupChars(value = "") {
  return String(value).match(new RegExp(`.{1,${GROUP_SIZE}}`, "g"))?.join(" ") ?? "";
}

export default function GroupedValue({ value }) {
  const grouped = groupChars(value);
  return (
    <span style={{ fontFamily: "monospace", overflowWrap: "anywhere" }}>
      <span aria-hidden="true">{grouped}</span>
      <span className="sr-only">{grouped}</span>
    </span>
  );
}
