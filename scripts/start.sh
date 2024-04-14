#!/bin/sh

trap 'killall k6' SIGINT SIGTERM

mkdir -p /mnt/output/reports

function stopButton() {
    while true
    do
        echo "To stop, please access 8001 port."
        echo -e "HTTP/1.1 202 Accepted\nContent-Length: 9\n\nstopping\n" | nc -v -l -p 8001
        killall k6
        echo "stop k6"
        sleep 2
    done
}

function main() {
    while true
    do
        echo "To restart, please access 8000 port."
        echo -e "HTTP/1.1 202 Accepted\nContent-Length: 11\n\nrestarting\n" | nc -v -l -p 8000
        killall k6
        export STARTED_AT=`cat /mnt/output/lastStarted`
        export K6_WEB_DASHBOARD_EXPORT=/mnt/output/reports/report-$STARTED_AT.html
        k6 run --quiet --address 0.0.0.0:6565 /mnt/output/script-$STARTED_AT.js | tee /mnt/output/reports/stdout-$STARTED_AT.txt &
        sleep 2
    done
}

cd /mnt/output/reports
main &
stopButton &
wait
