export const absoluteUrl = (urlValue) => new URL(urlValue, document.baseURI).href;

const compactFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});

export const formatBytes = (byteCount) => {
  if (!Number.isFinite(byteCount)) {
    return "Unknown size";
  }

  const sizeUnits = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(
    Math.floor(Math.log(byteCount) / Math.log(1024)),
    sizeUnits.length - 1,
  );
  const unitValue = byteCount / (1024 ** unitIndex);

  return `${compactFormatter.format(unitValue)} ${sizeUnits[unitIndex]}`;
};

export const firstParagraph = (textValue) => textValue
  ?.split(/\r?\n\s*\r?\n/)
  .find((paragraph) => paragraph.trim())
  ?.trim() || "";

export const formattedBlocks = (textValue) => textValue
  ?.split(/\r?\n\s*\r?\n/)
  .map((block) => block.trim())
  .filter(Boolean)
  .map((block) => {
    const lines = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const headingMatch = lines[0]?.match(/^([^:\n]{1,80}):$/);

    return {
      heading: headingMatch ? headingMatch[1] : null,
      lines: headingMatch ? lines.slice(1) : lines,
    };
  }) || [];

export const blockByHeading = (blocks, heading) =>
  blocks.find((block) => block.heading?.toLowerCase() === heading.toLowerCase());

export const segmentsFromLines = (lines) => {
  const segments = [];
  let paragraphLines = [];
  let listItems = [];

  const flushParagraph = () => {
    if (paragraphLines.length) {
      segments.push({ type: "p", text: paragraphLines.join(" ") });
      paragraphLines = [];
    }
  };

  const flushList = () => {
    if (listItems.length) {
      segments.push({ type: "ul", items: listItems.slice() });
      listItems = [];
    }
  };

  for (const line of lines) {
    const listItemMatch = line.match(/^-\s+(.+)$/);

    if (listItemMatch) {
      flushParagraph();
      listItems.push(listItemMatch[1]);
      continue;
    }

    flushList();
    paragraphLines.push(line);
  }

  flushParagraph();
  flushList();
  return segments;
};

export const releaseNoteLines = (releaseNotes) => releaseNotes
  ?.split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean) || [];
