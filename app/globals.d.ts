declare module "*.css";

// Komponen web App Bridge yang belum tercakup @shopify/polaris-types.
declare namespace JSX {
  interface IntrinsicElements {
    "ui-title-bar": React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement> & { title?: string },
      HTMLElement
    >;
    "s-app-nav": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
  }
}
