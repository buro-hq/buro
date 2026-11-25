import type { ReactNode, ReactElement } from 'react';
/** Groups a feature title, optional context and its content. */
export const Panel = ({
  title,
  description,
  aside,
  children,
  className = '',
}: {
  title: string;
  description?: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
  className?: string;
}): ReactElement => (
  <section className={`content-panel ${className}`}>
    <div className="section-heading">
      <div>
        <h2>{title}</h2>
        {description && <p className="caption">{description}</p>}
      </div>
      {aside}
    </div>
    {children}
  </section>
);
