function anchorHue(anchorId: string): number {
  let h = 0;
  for (let i = 0; i < anchorId.length; i++) {
    h = (h * 31 + anchorId.charCodeAt(i)) % 360;
  }
  return h;
}

export function anchorStrokeColor(anchorId: string): string {
  const hue = anchorHue(anchorId);
  return `hsl(${hue} 78% 48%)`;
}

export function anchorFillColor(anchorId: string, alpha = 0.16): string {
  const hue = anchorHue(anchorId);
  return `hsl(${hue} 88% 52% / ${alpha})`;
}

