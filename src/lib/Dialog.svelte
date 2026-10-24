<script>
  // A modal <dialog>, which brings the backdrop, focus trap and Escape. It shows while `open` is true.
  // As libadwaita does, opening focuses the dialog itself rather than its first button (the close
  // button), unless `focusSelf` is false.
  let { open = $bindable(false), id, class: className, labelledby, focusSelf = true, children } = $props();
  let dialog;

  $effect(() => {
    if (open && !dialog.open) {
      dialog.showModal();
      if (focusSelf) dialog.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  });
</script>

<!-- The close event comes a moment after closing; by then the dialog may be open again. -->
<dialog bind:this={dialog} {id} class={className} aria-labelledby={labelledby} tabindex={focusSelf ? -1 : undefined} onclose={() => (open = dialog.open)}>
  {@render children()}
</dialog>
