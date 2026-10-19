/** A Hairline figure: an isometric line drawing that answers the pointer (see kernel.js). */
export interface Figure {
  name: string
  /** One sentence: what the figure shows. */
  means: string
  rules: number[]
  /** The figure's own number at intensity 0, 0.5 and 1; the middle one is its default. */
  range: [number, number, number]
  /** The viewBox points an unseen pointer visits when the figure plays itself, ending with null (leave). */
  tour: ([number, number] | null)[] | null
  mount(host: { stage: HTMLElement; svg: SVGSVGElement; read: { textContent: string | null } }, value: number): {
    set(value: number): void
    destroy(): void
  }
}

/** The few kernel calls a page makes; the figures use the rest. */
export interface Kernel {
  inject(root: Document): void
  mk(tag: 'svg', attrs: Record<string, string>, parent: Element): SVGSVGElement
  tour(stage: HTMLElement, stops: ([number, number] | null)[], onStop?: (i: number) => void): { stop(): void }
}
