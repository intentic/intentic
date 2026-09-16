def make_widget(name):
    return {"name": name}


class WidgetBox:
    # Fixture anchor for read's scope chain: `beta/app.py::WidgetBox::pack` must not match the module-level pack.
    def pack(self):
        return [make_widget("boxed")]


def pack():
    return "module-level pack, same name, different scope"
