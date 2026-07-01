import { parseFlexibleDate } from './date-utils.js';

const FOOTER_START_LINES = new Set([
  '이전',
  '다음',
  '배송상품 주문상태 안내',
  '취소/반품/교환 신청전 확인해주세요!'
]);

export function splitMeaningfulLines(text) {
  return String(text ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

export function extractOrderDateInfo(text) {
  const candidates = splitMeaningfulLines(text)
    .map((line, lineIndex) => {
      const date = parseFlexibleDate(line);
      if (!date) return null;

      return {
        date,
        line,
        lineIndex,
        score: scoreDateLine(line)
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.lineIndex - b.lineIndex);

  return candidates[0] ?? null;
}

export function extractOrderBlocks(pageText) {
  const lines = splitMeaningfulLines(pageText);
  const blocks = [];
  let current = null;

  for (const line of lines) {
    if (current && isFooterStartLine(line)) {
      pushCurrentBlock(blocks, current);
      current = null;
      break;
    }

    const date = parseFlexibleDate(line);
    if (date && isOrderStartLine(line)) {
      pushCurrentBlock(blocks, current);
      current = {
        orderDate: date,
        rawDateText: line,
        lines: [line]
      };
      continue;
    }

    if (current) {
      current.lines.push(line);
    }
  }

  pushCurrentBlock(blocks, current);

  return blocks.map((block, index) => ({
    index: index + 1,
    orderDate: block.orderDate,
    rawDateText: block.rawDateText,
    lines: block.lines,
    text: block.lines.join('\n')
  }));
}

function pushCurrentBlock(blocks, block) {
  if (!block || block.lines.length === 0) return;
  blocks.push(block);
}

function isOrderStartLine(line) {
  return line.includes('주문') && !line.includes('주문목록');
}

function isFooterStartLine(line) {
  return FOOTER_START_LINES.has(line);
}

function scoreDateLine(line) {
  let score = 0;

  if (line.includes('주문')) score += 100;
  if (/^\d{4}/.test(line)) score += 20;
  if (line.includes('주문목록')) score -= 200;
  if (/(도착|배송|취소|반품|교환|안내)/.test(line)) score -= 40;

  return score;
}
