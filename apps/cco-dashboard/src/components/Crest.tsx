const LEAVES: Array<[number, number, number]> = [
  [5.4, 14.6, -35],
  [4.8, 18.6, -12],
  [5.4, 22.6, 14],
  [7.2, 25.9, 42],
];

function Laurel() {
  return (
    <g>
      <path d="M9.4 28.6 C5.2 25.8 3.8 19.4 6.2 12.4" fill="none" stroke="var(--santos-green)" strokeWidth={1.1} strokeLinecap="round" />
      {LEAVES.map(([cx, cy, rot]) => (
        <ellipse key={`${cx}-${cy}`} cx={cx} cy={cy} rx={1.9} ry={0.85} fill="var(--santos-green)" transform={`rotate(${rot} ${cx} ${cy})`} />
      ))}
    </g>
  );
}

/**
 * Brasão estilizado a partir da bandeira de Santos: coroa mural dourada,
 * escudo vermelho com bordadura dourada, ramos de louro e listel. Uso
 * decorativo — identidade do painel, nunca codificação de dado.
 */
export function Crest({ size = 30, className }: { size?: number; className?: string }) {
  return (
    <svg className={className ? `crest ${className}` : 'crest'} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M10 8.6 V3 H12.9 V4.7 H14.6 V3 H17.4 V4.7 H19.1 V3 H22 V8.6 Z" fill="var(--santos-gold)" />
      <Laurel />
      <g transform="translate(32 0) scale(-1 1)">
        <Laurel />
      </g>
      <path
        d="M9.6 10 H22.4 V17.6 C22.4 22.4 19.5 25.9 16 27.4 C12.5 25.9 9.6 22.4 9.6 17.6 Z"
        fill="var(--santos-red)"
        stroke="var(--santos-gold)"
        strokeWidth={1.1}
      />
      <path d="M12 12.4 H20 V17.4 C20 20.6 18.3 23 16 24.2 C13.7 23 12 20.6 12 17.4 Z" fill="none" stroke="var(--santos-gold)" strokeWidth={0.5} opacity={0.7} />
      <path d="M7.6 28.4 Q16 31.6 24.4 28.4" fill="none" stroke="var(--santos-red)" strokeWidth={1.7} strokeLinecap="round" />
    </svg>
  );
}
