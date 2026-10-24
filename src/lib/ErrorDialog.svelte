<script>
  import Dialog from "./Dialog.svelte";
  import { revealItemInDir } from "./tauri.js";

  // An alert for a failed run. `error` is { text, log } (the log file behind Show Log), or null.
  let { error = $bindable() } = $props();
</script>

<Dialog
  bind:open={() => !!error, (open) => !open && (error = null)}
  id="error"
  class="alert"
  labelledby="error-title"
  focusSelf={false}
>
  <h2 id="error-title">Couldn't Make the Splat</h2>
  <p>{error?.text}</p>
  <div class="responses">
    {#if error?.log}
      <button type="button" class="btn pill" onclick={() => revealItemInDir(error.log)}>Show Log</button>
    {/if}
    <!-- svelte-ignore a11y_autofocus: opening the alert focuses Close, its safe answer -->
    <button type="button" class="btn pill" autofocus onclick={() => (error = null)}>Close</button>
  </div>
</Dialog>
