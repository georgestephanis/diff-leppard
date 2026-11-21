Add --remove-stale to the page sync

Unpublishes remote pages that are no longer ready locally. New: refuses to run
when --src is empty or missing, so a bad path can't unpublish the whole site.
