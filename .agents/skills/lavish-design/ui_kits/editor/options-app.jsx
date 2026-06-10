/* global React, DesignCanvas, DCSection, DCArtboard, ChromeBaseline, ChromeQuiet, ChromeOverflow, ChromeUnified */

const noteStyle = {
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  lineHeight: 1.5,
  color: "var(--steel-100)",
};
const tagStyle = {
  display: "inline-block",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--brass-500)",
  marginBottom: 6,
  letterSpacing: "0.04em",
};

function Caption({ tag, children }) {
  return (
    <div style={{ width: 820, marginTop: 10 }}>
      <div style={tagStyle}>{tag}</div>
      <div style={noteStyle} dangerouslySetInnerHTML={{ __html: children }} />
    </div>
  );
}

function OptionsApp() {
  return (
    <DesignCanvas>
      <DCSection
        id="baseline"
        title="Where it is today"
        subtitle="Five competing controls: two filled-weight bar buttons, a floating Cancel/Queue pair, pill × chips, and Send."
      >
        <DCArtboard id="current" label="Current chrome" width={820} height={500}>
          <ChromeBaseline />
        </DCArtboard>
      </DCSection>

      <DCSection
        id="options"
        title="Three ways to quiet it down"
        subtitle="Each keeps a single filled brass action — Send — and demotes everything else."
      >
        <DCArtboard id="quiet" label="A · Quiet bar" width={820} height={560}>
          <ChromeQuiet />
          <Caption tag="A · QUIET BAR — smallest change">
            The two bar buttons become a <b>switch</b> (Annotate) and a single <b>icon</b> (end session). The floating card loses its filled Cancel — now a quiet text link beside a compact <b>Queue</b>. One filled button survives anywhere on screen: <b>Send</b>. Lowest-risk; keeps every existing flow intact.
          </Caption>
        </DCArtboard>

        <DCArtboard id="overflow" label="B · Overflow menu" width={820} height={560}>
          <ChromeOverflow />
          <Caption tag="B · OVERFLOW MENU — emptiest bar">
            The bar collapses to <b>wordmark · file · Annotate switch · ⋯</b>. End Session, snapshot, reload all live behind the <b>⋯</b> menu. Send becomes an <b>icon inside the textarea</b>, so the composer reads as one object instead of input-plus-button. Calmest top edge; the trade is one extra click to reach session controls.
          </Caption>
        </DCArtboard>

        <DCArtboard id="unified" label="C · Unified composer" width={820} height={560}>
          <ChromeUnified />
          <Caption tag="C · UNIFIED COMPOSER — fewest controls (recommended)">
            The floating annotation card <b>disappears entirely</b>. Clicking an element drops a <b>context chip</b> (“editing &lt;h1&gt;”) above the one composer — you type and Send like any message. This removes the whole Cancel/Queue cluster <i>and</i> the separate floating input. One place to write, one action to send. Biggest behavioral change, but the most elegant end state.
          </Caption>
        </DCArtboard>
      </DCSection>
    </DesignCanvas>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<OptionsApp />);
