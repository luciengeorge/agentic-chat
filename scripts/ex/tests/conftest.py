import textwrap
from pathlib import Path

import pytest

GRADED = """---
title: Greeting
type: graded
slots:
  {module}: greeting.py
---
"""


def write_step(
    root: Path, section: str, num: int, slug: str, readme: str, files: dict[str, dict[str, str]]
) -> None:
    for kind in ("problem", "solution"):
        directory = root / "exercises" / section / f"{num:02d}.{kind}.{slug}"
        directory.mkdir(parents=True)
        (directory / "README.mdx").write_text(readme)
        for name, text in files.get(kind, {}).items():
            (directory / name).write_text(textwrap.dedent(text))


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A guided tour step, and a hidden graded step slotting `exrefpkg.greeting`."""
    root = tmp_path / "repo"
    root.mkdir()
    (root / "pyproject.toml").write_text("[project]\nname = 't'\n")
    (root / "conftest.py").write_text(
        "from pathlib import Path\n"
        "from ac_core.slots import install\n\n"
        "install(root=Path(__file__).parent)\n"
    )
    package = root / "src" / "exrefpkg"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("")
    (package / "greeting.py").write_text("def greet(name: str) -> str:\n    return f'hi {name}'\n")
    (root / "exercises" / "00.tour").mkdir(parents=True)
    (root / "exercises" / "00.tour" / "README.mdx").write_text("---\ntitle: Tour\n---\n")
    write_step(root, "00.tour", 1, "run", "---\ntitle: Run\ntype: guided\n---\n", {})
    (root / "exercises" / "_smoke").mkdir()
    (root / "exercises" / "_smoke" / "README.mdx").write_text("---\ntitle: S\nhidden: true\n---\n")
    test_file = """
        from exrefpkg.greeting import greet

        def test_greet():
            assert greet("x") == "hello x"
    """
    write_step(
        root,
        "_smoke",
        1,
        "greeting",
        GRADED.format(module="exrefpkg.greeting"),
        {
            "problem": {
                "greeting.py": "def greet(name):\n    raise NotImplementedError\n",
                "test_greeting.py": test_file,
            },
            "solution": {
                "greeting.py": "def greet(name):\n    return f'hello {name}'\n",
                "test_greeting.py": test_file,
            },
        },
    )
    return root


@pytest.fixture(autouse=True)
def _reference_package_on_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("PYTHONPATH", str(tmp_path / "repo" / "src"))
