class Site:
    def publish(self, page):
        raise NotImplementedError

    def published_slugs(self):
        raise NotImplementedError

    def unpublish(self, slug):
        raise NotImplementedError
