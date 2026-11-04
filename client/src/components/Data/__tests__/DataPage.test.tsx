import React from 'react';
import { render, screen } from '@testing-library/react';
import DataPage from '../DataPage';

describe('DataPage', () => {
  it('frames the DuckDB UI through the dev server and links to it', () => {
    render(<DataPage />);

    const frame = screen.getByTitle('Data explorer');
    expect(frame).toHaveAttribute('src', '/welcome');
    expect(screen.getByRole('link', { name: 'Open in new tab' })).toHaveAttribute(
      'href',
      '/welcome',
    );
  });
});
