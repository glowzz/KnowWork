"""桌面端扩展的测试：把扩展包的 src 加进 import 路径（扩展在 extensions/desktop，不在 server 包里），
其余复用服务端的测试基建（根 conftest 的数据库与 fixtures）。"""

import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[3] / "extensions" / "desktop" / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))
