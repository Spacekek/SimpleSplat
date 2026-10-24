<script>
  import { DETAILS, cap, describe, detailIndex, grouped, presetValue, settings } from "./settings.svelte.js";

  // One advanced setting: a select when it has `options` ([value, label] pairs), a spin row when it
  // steps `by` an amount, else a switch. Under its title, its default at each Detail.
  let { name, title, subtitle = "", options, min, step, by } = $props();
  const isSwitch = $derived(!options && !by);

  const preset = $derived(settings.presets[detailIndex()]);
  const value = $derived(preset && presetValue(name, preset)); // the default at this Detail
  const defaults = $derived(settings.presets.map((p) => describe(name, presetValue(name, p))));
  const same = $derived(defaults.every((d) => d === defaults[0]));

  // − and + step from the field's value or, when it is empty, from the default.
  function stepBy(direction) {
    const own = settings.values[name];
    const from = own === "" || own == null ? Number(value ?? 0) : Number(own);
    settings.values[name] = Math.max(min, from + direction * by);
  }
</script>

<label class="row">
  <div class="row-text">
    <div class="title">{title}</div>
    {#if subtitle}
      <div class="subtitle">{subtitle}</div>
    {/if}
    <!-- The same at every Detail: a field's placeholder or an Auto option already says it; a switch can't. -->
    <div class="subtitle defaults" hidden={!defaults.length || (same && !isSwitch)}>
      {#if same}
        Default: {defaults[0]}
      {:else if defaults.every((d, i) => d === cap(DETAILS[i]))}
        Default: the same as Detail
      {:else}
        Default: {#each defaults as d, i}{#if i}{" · "}{/if}{#if i === detailIndex()}<strong>{cap(DETAILS[i])} {d}</strong>{:else}<span>{cap(DETAILS[i])} {d}</span>{/if}{/each}
      {/if}
    </div>
  </div>
  {#if options}
    <select {name} bind:value={settings.values[name]}>
      <!-- Single Camera's Auto depends on the input, not on Detail, so its text stays short. -->
      <option value="">{value == null ? "Auto" : `Auto (${describe(name, value)})`}</option>
      {#each options as [optionValue, label]}
        <option value={optionValue}>{label}</option>
      {/each}
    </select>
  {:else if by}
    <div class="spin">
      <input type="number" {name} {min} {step} placeholder={preset ? grouped(Number(value)) : undefined} bind:value={settings.values[name]} />
      <button type="button" class="btn flat circular" aria-label="Less" onclick={() => stepBy(-1)}>−</button>
      <button type="button" class="btn flat circular" aria-label="More" onclick={() => stepBy(1)}>+</button>
    </div>
  {:else}
    <input type="checkbox" class="switch" {name} bind:checked={settings.values[name]} />
  {/if}
</label>
