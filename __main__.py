"""Entry point to allow running this folder with `python .` or `python path/to/folder`.

This delegates to `blackjack.main()`.
"""

from __future__ import annotations

import blackjack


def _run() -> None:
    blackjack.main()


if __name__ == "__main__":
    _run()
