#!/bin/sh
# greenboot's required check: Docker answers, and every sandbox that ran before this boot runs again with its
# daemon answering. A red verdict reboots; three red boots in a row roll back to the previous deployment.
exec /usr/bin/ic os health --wait 600
