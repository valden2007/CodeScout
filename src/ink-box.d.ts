declare module 'ink-box' {
  import React from 'react';

  interface InkBoxProps extends React.PropsWithChildren<Record<string, unknown>> {
    borderStyle?: string;
    borderColor?: string;
    padding?: number;
    marginTop?: number;
    marginBottom?: number;
  }

  const InkBox: React.ComponentType<InkBoxProps>;
  export default InkBox;
}
