import * as Slider from '@radix-ui/react-slider';
import { LEVEL_INFO, LEVEL_ORDER } from '@advpipe/contracts';

/**
 * "How much checking" (docs/05 §5.4): a Radix slider from Basic (1) to Full (5). The labels are
 * visible text under the track, and the thumb reads out its level's name, not "3".
 */
export function LevelSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const labels = LEVEL_ORDER.map((l) => LEVEL_INFO[l].label);
  return (
    <div className="level-slider">
      <Slider.Root
        className="slider-root"
        min={1}
        max={5}
        step={1}
        value={[value]}
        onValueChange={([n]) => {
          if (n !== undefined) onChange(n);
        }}
      >
        <Slider.Track className="slider-track">
          <Slider.Range className="slider-range" />
        </Slider.Track>
        <Slider.Thumb
          className="slider-thumb"
          aria-label="How much checking: 1 is Basic, 5 is Full"
          aria-valuetext={labels[value - 1] ?? ''}
        />
      </Slider.Root>
      <ol className="level-ticks" aria-hidden="true">
        {labels.map((label, i) => (
          <li key={label} className={i + 1 === value ? 'on' : ''}>
            {label}
          </li>
        ))}
      </ol>
    </div>
  );
}
