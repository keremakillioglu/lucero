import React from 'react';
import { RecoilRoot } from 'recoil';
import { fireEvent, render, screen } from '@testing-library/react';
import Turn from '../Turn';

const turn = {
  id: 't1',
  prompt: 'BabyLab revenue by country',
  overview: 'US drives 60% of revenue.',
  createdAt: '2026-10-28T10:00:00.000Z',
};

describe('Turn', () => {
  it('shows the prompt, the AI overview and the turn charts', () => {
    render(
      <RecoilRoot>
        <Turn turn={turn}>
          <div data-testid="turn-chart" />
        </Turn>
      </RecoilRoot>,
    );
    const section = screen.getByRole('region', { name: 'Prompt: BabyLab revenue by country' });
    expect(section).toHaveTextContent('BabyLab revenue by country');
    expect(section).toHaveTextContent('US drives 60% of revenue.');
    expect(section).toContainElement(screen.getByTestId('turn-chart'));
  });

  it('omits the overview when the model returned none', () => {
    const { overview: _overview, ...withoutOverview } = turn;
    render(
      <RecoilRoot>
        <Turn turn={withoutOverview}>{null}</Turn>
      </RecoilRoot>,
    );
    expect(screen.queryByText('US drives 60% of revenue.')).not.toBeInTheDocument();
  });

  it('runs all charts from the button below the summary, and hides it without charts', () => {
    const onRunAll = jest.fn();
    const { rerender } = render(
      <RecoilRoot>
        <Turn turn={turn} onRunAll={onRunAll}>
          <div data-testid="turn-chart" />
        </Turn>
      </RecoilRoot>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Run all' }));
    expect(onRunAll).toHaveBeenCalledTimes(1);

    rerender(
      <RecoilRoot>
        <Turn turn={turn}>{null}</Turn>
      </RecoilRoot>,
    );
    expect(screen.queryByRole('button', { name: 'Run all' })).not.toBeInTheDocument();
  });
});
